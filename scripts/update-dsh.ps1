<#
  dsh-updater -- update runner (the background process the host half starts)

  This script decides nothing by itself. Which version to install comes from the
  plan.json the host wrote. It only does four things in order, and backs out of
  each one when it fails:

    1. wait for the running DSH to exit (taskkill it if it will not)
    2. back up package.json / package-lock.json, then npm install the target
    3. verify node_modules really holds that version
    4. start DSH again; if it does not come up, restore the backup and start the
       previous version

  Everything goes into logFile. The final verdict goes into resultFile -- after
  DSH is back, the status route reads it and shows it on the badge.

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a BOM-less .ps1
  as ANSI, so UTF-8 comment text can break the parser on a CJK code page.

  Syntax is Windows PowerShell 5.1: no `??`, no ternary operator.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Plan,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# A bootstrap line goes down before anything can fail, next to the plan file.
# If the run dies before $cfg exists (unreadable plan, broken JSON), the log the
# host told the UI about would never appear -- this one always does.
$script:BootstrapLog = Join-Path (Split-Path -Parent $Plan) 'bootstrap.log'

function Write-Bootstrap {
  param([string]$Message)
  try {
    Add-Content -LiteralPath $script:BootstrapLog -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message) -Encoding UTF8
  } catch { }
}

Write-Bootstrap ('start pid={0} plan={1}' -f $PID, $Plan)

# Detach from the console this was started from.
#
# Why: the host cannot create a detached process on this machine (libuv's
# DETACHED_PROCESS starts a shell that never executes anything), so the host
# starts this script the ordinary way. When the host exits, its console closes
# and takes every process still attached to it down -- including this one, right
# in the middle of npm install. FreeConsole cuts that link first; after it, the
# console closing no longer reaches us.
#
# The host waits for 'detach ...=True' in this log before it exits, so a failed
# detach aborts the whole update instead of leaving a half-dead machine.
# GetConsoleWindow()==0 means there is no console to detach from at all (the host
# itself may be console-free) -- that counts as detached, nothing can take us down.
$script:Detached = $false
try {
  $signature = @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
[DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
'@
  $native = Add-Type -MemberDefinition $signature -Name 'ConsoleNative' -Namespace 'DshUpdater' -PassThru -ErrorAction Stop
  $inJob = $false
  try { $native::IsProcessInJob($native::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob) | Out-Null } catch { }
  Write-Bootstrap ('job injob={0}' -f $inJob)
  if ($native::GetConsoleWindow() -eq [IntPtr]::Zero) {
    $script:Detached = $true
    Write-Bootstrap 'detach noconsol=True'
  } else {
    $script:Detached = [bool]$native::FreeConsole()
    Write-Bootstrap ('detach freeconsole={0}' -f $script:Detached)
  }
} catch {
  Write-Bootstrap ('detach FAILED: ' + $_.Exception.Message)
}

if (-not $DryRun -and $script:Detached -ne $true) {
  Write-Bootstrap 'detach: aborting before touching anything'
  exit 3
}

try {
  $cfg = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Write-Bootstrap ('FAILED to read the plan: ' + $_.Exception.Message)
  exit 1
}

Write-Bootstrap ('version {0} (from {1}), core {2}' -f $cfg.version, $cfg.fromVersion, $cfg.coreDir)

$script:LogFile = $cfg.logFile
$script:ServerProcess = $null

# ------------------------------------------------------------------ helpers

function Write-Log {
  param([string]$Message)
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
  try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { }
}

function Get-PackageVersion {
  param([string]$PackageJson)
  if (-not (Test-Path -LiteralPath $PackageJson)) { return $null }
  try {
    $json = Get-Content -LiteralPath $PackageJson -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$json.version
  } catch {
    return $null
  }
}

function Get-ServerProcess {
  try { return Get-Process -Id ([int]$cfg.serverPid) -ErrorAction SilentlyContinue } catch { return $null }
}

function Write-Result {
  param(
    [bool]$Ok,
    [string]$ErrorMessage,
    [bool]$Rollback
  )
  $payload = [ordered]@{
    ok       = $Ok
    running  = $false
    from     = [string]$cfg.fromVersion
    to       = [string]$cfg.version
    at       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    rollback = $Rollback
    error    = $ErrorMessage
    logFile  = $script:LogFile
  }
  try {
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $cfg.resultFile -Encoding UTF8
  } catch {
    Write-Log ('WARN: could not write result file: ' + $_.Exception.Message)
  }
}

# How npm is launched. Node 24 refuses to spawn a .cmd directly (EINVAL), so the
# host also passes npm-cli.js: when present, run it with node; otherwise npm.cmd.
function Get-NpmLauncher {
  if ($cfg.npmCli) {
    return @{ file = [string]$cfg.nodePath; prefix = ('"' + [string]$cfg.npmCli + '"') }
  }
  return @{ file = [string]$cfg.npmPath; prefix = '' }
}

function Join-ArgLine {
  param([string]$Prefix, [string[]]$Arguments)
  $parts = @()
  if ($Prefix -ne '') { $parts += $Prefix }
  foreach ($a in $Arguments) {
    if ($a -match '\s') { $parts += ('"' + $a + '"') } else { $parts += $a }
  }
  return ($parts -join ' ')
}

function Invoke-NpmInstall {
  param([string[]]$NpmArgs, [string]$Tag)

  $outLog = Join-Path $cfg.logDir ('npm-{0}-out.log' -f $Tag)
  $errLog = Join-Path $cfg.logDir ('npm-{0}-err.log' -f $Tag)
  Write-Log ('npm {0}' -f ($NpmArgs -join ' '))

  $launcher = Get-NpmLauncher
  $argLine = Join-ArgLine -Prefix $launcher.prefix -Arguments $NpmArgs
  Write-Log ('  via {0} {1}' -f $launcher.file, $argLine)

  $proc = Start-Process -FilePath $launcher.file `
    -ArgumentList $argLine `
    -WorkingDirectory $cfg.coreDir `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

  $deadline = (Get-Date).AddSeconds([int]$cfg.timeoutSeconds)
  while (-not $proc.HasExited) {
    if ((Get-Date) -gt $deadline) {
      try { $proc.Kill() } catch { }
      Write-Log ('npm timed out after {0}s' -f $cfg.timeoutSeconds)
      return 124
    }
    Start-Sleep -Milliseconds 400
  }

  # Start-Process -PassThru hands back a Process object whose ExitCode stays empty
  # until the handle is refreshed -- reading it raw reported "exit " and made a
  # successful install look like a failure. WaitForExit + Refresh fills it in.
  $code = $null
  try {
    $proc.WaitForExit()
    $proc.Refresh()
    $code = $proc.ExitCode
  } catch {
    Write-Log ('npm exit code unreadable: ' + $_.Exception.Message)
  }
  Write-Log ('npm exit code {0}' -f $(if ($null -eq $code) { '(unknown)' } else { $code }))
  return $code
}

function Show-NpmTail {
  param([string]$Tag)
  foreach ($name in @('err', 'out')) {
    $file = Join-Path $cfg.logDir ('npm-{0}-{1}.log' -f $Tag, $name)
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $tail = Get-Content -LiteralPath $file -Tail 20 -ErrorAction SilentlyContinue
    foreach ($line in @($tail)) {
      if ($line) { Write-Log ('  | ' + $line) }
    }
  }
}

function Start-DshServer {
  $quoted = @()
  foreach ($a in @($cfg.argv)) { $quoted += ('"' + $a + '"') }
  $argLine = ('"' + $cfg.entryPath + '" ' + ($quoted -join ' ')).TrimEnd()

  Write-Log ('starting server: {0} {1}' -f $cfg.nodePath, $argLine)
  Write-Log ('working dir   : {0}' -f $cfg.workDir)
  $script:ServerProcess = Start-Process -FilePath $cfg.nodePath -ArgumentList $argLine -WorkingDirectory $cfg.workDir -PassThru
  Write-Log ('server pid    : {0}' -f $script:ServerProcess.Id)
}

function Test-DshServer {
  param([int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $proc = $script:ServerProcess
    if ($null -ne $proc) {
      try { if ($proc.HasExited) { return $false } } catch { }
    }
    if ([int]$cfg.port -gt 0) {
      try {
        $listening = Get-NetTCPConnection -State Listen -LocalPort ([int]$cfg.port) -ErrorAction Stop
        if ($null -ne $listening) { return $true }
      } catch { }
    } else {
      return $true
    }
    Start-Sleep -Milliseconds 700
  }
  return $false
}

function Restore-Backup {
  param([string]$BackupDir)
  if (Test-Path -LiteralPath (Join-Path $BackupDir 'package.json')) {
    Copy-Item -LiteralPath (Join-Path $BackupDir 'package.json') -Destination (Join-Path $cfg.coreDir 'package.json') -Force
  }
  if (Test-Path -LiteralPath (Join-Path $BackupDir 'package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $BackupDir 'package-lock.json') -Destination (Join-Path $cfg.coreDir 'package-lock.json') -Force
  }
}

# ---- profile side (plugins) ------------------------------------------------

# Why this exists: the plugin market refuses to install a plugin whose declared
# dsh range does not cover the RUNNING core. So a plugin that only supports the
# new core cannot be installed before the core moves. This script installs the
# core first, then the plugins, then starts DSH once - the one window where the
# core on disk and the plugins on disk are both new and nothing is running.

function Get-PnpmLauncher {
  if ($cfg.pnpmCli) {
    return @{ file = [string]$cfg.nodePath; prefix = ('"' + [string]$cfg.pnpmCli + '"') }
  }
  return @{ file = [string]$env:ComSpec; prefix = '/d /s /c pnpm' }
}

function Invoke-Pnpm {
  param([string[]]$PnpmArgs, [string]$Tag)

  $outLog = Join-Path $cfg.logDir ('pnpm-{0}-out.log' -f $Tag)
  $errLog = Join-Path $cfg.logDir ('pnpm-{0}-err.log' -f $Tag)
  Write-Log ('pnpm {0}' -f ($PnpmArgs -join ' '))

  $launcher = Get-PnpmLauncher
  $argLine = Join-ArgLine -Prefix $launcher.prefix -Arguments $PnpmArgs
  Write-Log ('  via {0} {1}' -f $launcher.file, $argLine)

  $proc = Start-Process -FilePath $launcher.file `
    -ArgumentList $argLine `
    -WorkingDirectory $cfg.profileDir `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

  $deadline = (Get-Date).AddSeconds([int]$cfg.timeoutSeconds)
  while (-not $proc.HasExited) {
    if ((Get-Date) -gt $deadline) {
      try { $proc.Kill() } catch { }
      Write-Log ('pnpm timed out after {0}s' -f $cfg.timeoutSeconds)
      return 124
    }
    Start-Sleep -Milliseconds 400
  }
  # Same Start-Process quirk as npm: refresh before reading ExitCode.
  $code = $null
  try {
    $proc.WaitForExit()
    $proc.Refresh()
    $code = $proc.ExitCode
  } catch {
    Write-Log ('pnpm exit code unreadable: ' + $_.Exception.Message)
  }
  Write-Log ('pnpm exit code {0}' -f $(if ($null -eq $code) { '(unknown)' } else { $code }))
  return $code
}

function Backup-Profile {
  $dir = Join-Path $cfg.backupDir 'profile'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($name in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
    $source = Join-Path $cfg.profileDir $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $dir $name) -Force
    }
  }
  Write-Log ('backed up profile files in {0}' -f $dir)
}

function Restore-Profile {
  $dir = Join-Path $cfg.backupDir 'profile'
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'package.json'))) { return }
  foreach ($name in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')) {
    $source = Join-Path $dir $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $cfg.profileDir $name) -Force
    }
  }
  $code = Invoke-Pnpm -PnpmArgs @('install', '--reporter=append-only') -Tag 'rollback-profile'
  Write-Log ('profile rollback: exit {0}' -f $code)
}

# ------------------------------------------------------------------ start

Write-Log '---------- dsh-updater ----------'
Write-Log ('plan           : {0}' -f $Plan)
Write-Log ('target version : {0}  (installed: {1})' -f $cfg.version, $cfg.fromVersion)
Write-Log ('core dir       : {0}' -f $cfg.coreDir)
Write-Log ('server pid     : {0}' -f $cfg.serverPid)

$corePackage = Join-Path $cfg.coreDir 'package.json'
$lockFile    = Join-Path $cfg.coreDir 'package-lock.json'
$dshPackage  = Join-Path $cfg.coreDir 'node_modules\@deepseek-ai\dsh\package.json'

# Read the plan back and check the paths it names. Touches nothing.
if ($DryRun) {
  Write-Log 'dry run: nothing gets stopped, installed or started'
  $checks = @(
    @{ label = 'core package.json'; path = $corePackage },
    @{ label = 'installed package' ; path = $dshPackage },
    @{ label = 'npm'               ; path = [string]$cfg.npmPath },
    @{ label = 'entry'             ; path = [string]$cfg.entryPath },
    @{ label = 'log dir'           ; path = [string]$cfg.logDir }
  )
  foreach ($check in $checks) {
    $present = $false
    try { $present = Test-Path -LiteralPath $check.path } catch { $present = $false }
    if ($present) {
      Write-Log ('  [ok]   {0}: {1}' -f $check.label, $check.path)
    } else {
      Write-Log ('  [MISS] {0}: {1}' -f $check.label, $check.path)
    }
  }
  $nowVersion = Get-PackageVersion -PackageJson $dshPackage
  Write-Log ('  would install @deepseek-ai/dsh {0}, currently {1}' -f $cfg.version, $nowVersion)
  $launcher = Get-NpmLauncher
  $wouldArgs = @('install', ('@deepseek-ai/dsh@' + [string]$cfg.version), '--save-exact', '--no-audit', '--no-fund', '--registry', [string]$cfg.registry)
  Write-Log ('  would stop pid {0}, then run: {1} {2}' -f $cfg.serverPid, $launcher.file, (Join-ArgLine -Prefix $launcher.prefix -Arguments $wouldArgs))
  if (@($cfg.plugins | Where-Object { $null -ne $_ }).Count -gt 0) {
    Write-Log ('  would also install: {0}' -f ((@($cfg.plugins) | ForEach-Object { $_.name + '@' + $_.to }) -join ', '))
  }
  Write-Log ('  would restart: {0} "{1}" {2}' -f $cfg.nodePath, $cfg.entryPath, ((@($cfg.argv)) -join ' '))
  exit 0
}

# Mark the run as in progress right away: the host is already gone, and the old
# verdict must not stay on the badge.
try {
  [ordered]@{
    ok       = $false
    running  = $true
    from     = [string]$cfg.fromVersion
    to       = [string]$cfg.version
    at       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    rollback = $false
    error    = $null
    logFile  = $script:LogFile
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $cfg.resultFile -Encoding UTF8
} catch { }

# ------------------------------------------------------------------ 1. stop

if ($null -ne (Get-ServerProcess)) {
  Write-Log ('waiting for pid {0} to exit (up to {1}s) ...' -f $cfg.serverPid, $cfg.stopTimeoutSeconds)
  $deadline = (Get-Date).AddSeconds([int]$cfg.stopTimeoutSeconds)
  while ($null -ne (Get-ServerProcess)) {
    if ((Get-Date) -gt $deadline) {
      Write-Log 'still alive; taskkill /F'
      try { & taskkill.exe /PID ([string]$cfg.serverPid) /T /F 2>&1 | Out-Null } catch { }
      Start-Sleep -Seconds 2
      break
    }
    Start-Sleep -Milliseconds 300
  }
} else {
  Write-Log 'server pid already gone'
}

if ($null -ne (Get-ServerProcess)) {
  Write-Log 'WARN: old server may still be running; continuing anyway'
} else {
  Write-Log 'old server stopped'
}

# ------------------------------------------------------- 2. back up, install

$backupDir = $cfg.backupDir
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Copy-Item -LiteralPath $corePackage -Destination (Join-Path $backupDir 'package.json') -Force
Write-Log 'backed up package.json'
if (Test-Path -LiteralPath $lockFile) {
  Copy-Item -LiteralPath $lockFile -Destination (Join-Path $backupDir 'package-lock.json') -Force
  Write-Log 'backed up package-lock.json'
}

$installArgs = @(
  'install',
  ('@deepseek-ai/dsh@{0}' -f $cfg.version),
  '--save-exact',
  '--no-audit',
  '--no-fund',
  '--registry', [string]$cfg.registry
)
$restoreArgs = @('install', '--no-audit', '--no-fund', '--registry', [string]$cfg.registry)

$exitCode = Invoke-NpmInstall -NpmArgs $installArgs -Tag 'install'
$installedVersion = Get-PackageVersion -PackageJson $dshPackage

# The version on disk is the real verdict; the exit code can be unreadable
# ($null) and must not turn a finished install into a failure on its own.
$exitOk = ($null -eq $exitCode) -or ([int]$exitCode -eq 0)
$versionOk = ($installedVersion -eq [string]$cfg.version)

if ((-not $exitOk) -or (-not $versionOk)) {
  Write-Log ('install FAILED (exit {0}, package now {1})' -f $(if ($null -eq $exitCode) { 'unknown' } else { $exitCode }), $installedVersion)
  Show-NpmTail -Tag 'install'

  Write-Log 'rolling back package.json / package-lock.json'
  Restore-Backup -BackupDir $backupDir
  $rollbackExit = Invoke-NpmInstall -NpmArgs $restoreArgs -Tag 'rollback'
  $restored = Get-PackageVersion -PackageJson $dshPackage
  Write-Log ('rollback: exit {0}, package now {1}' -f $(if ($null -eq $rollbackExit) { 'unknown' } else { $rollbackExit }), $restored)
  if (-not (($null -eq $rollbackExit) -or ([int]$rollbackExit -eq 0))) { Show-NpmTail -Tag 'rollback' }

  try { Start-DshServer } catch {
    Write-Log ('ERROR: could not restart after rollback: ' + $_.Exception.Message)
  }
  Write-Result -Ok $false -Rollback $true -ErrorMessage ('npm install failed (exit {0}); rolled back to {1}' -f $exitCode, $cfg.fromVersion)
  exit 1
}

Write-Log ('install verified: @deepseek-ai/dsh {0}' -f $installedVersion)

# ------------------------------------------------- 3. plugins that must follow
# A plugin whose dsh range only covers the new core cannot be installed while the
# old core is still running (the market refuses). Here the core is already new and
# nothing is running yet, so pnpm can install them for real.

$profileTouched = $false
$pendingPlugins = @($cfg.plugins | Where-Object { $null -ne $_ })
if ($null -ne $cfg.profileDir -and [string]$cfg.profileDir -ne '' -and $pendingPlugins.Count -gt 0) {
  Write-Log ('plugins to update: {0}' -f (($pendingPlugins | ForEach-Object { $_.name + ' ' + $_.from + ' -> ' + $_.to }) -join ', '))
  Backup-Profile
  $profileTouched = $true

  $pluginFailure = $null
  foreach ($plugin in $pendingPlugins) {
    $tag = 'plugin-' + ([string]$plugin.name -replace '[\\/@]', '_')
    $code = Invoke-Pnpm -PnpmArgs @('add', ([string]$plugin.name + '@' + [string]$plugin.to), '--save-exact', '--reporter=append-only') -Tag $tag
    $manifestPath = Join-Path $cfg.profileDir ('node_modules\' + [string]$plugin.name + '\package.json')
    $nowVersion = Get-PackageVersion -PackageJson $manifestPath
    $codeOk = ($null -eq $code) -or ([int]$code -eq 0)
    if ((-not $codeOk) -or ($nowVersion -ne [string]$plugin.to)) {
      Write-Log ('plugin FAILED: {0} (exit {1}, package now {2})' -f $plugin.name, $(if ($null -eq $code) { 'unknown' } else { $code }), $nowVersion)
      $pluginFailure = $plugin
      break
    }
    Write-Log ('plugin verified: {0} {1}' -f $plugin.name, $nowVersion)
  }

  if ($null -ne $pluginFailure) {
    Write-Log 'rolling back profile + core'
    Restore-Profile
    Restore-Backup -BackupDir $backupDir
    $rollbackExit = Invoke-NpmInstall -NpmArgs $restoreArgs -Tag 'rollback'
    $restored = Get-PackageVersion -PackageJson $dshPackage
    Write-Log ('core rollback: exit {0}, package now {1}' -f $rollbackExit, $restored)
    try { Start-DshServer } catch {
      Write-Log ('ERROR: could not restart after rollback: ' + $_.Exception.Message)
    }
    Write-Result -Ok $false -Rollback $true -ErrorMessage ('plugin {0} could not be installed; rolled back' -f $pluginFailure.name)
    exit 1
  }
} elseif ($pendingPlugins.Count -gt 0) {
  Write-Log 'WARN: plugin updates were requested but the plan has no profile directory; skipping them'
}

# ------------------------------------------------------------------ 4. start

try {
  Start-DshServer
} catch {
  Write-Log ('ERROR: could not start server: ' + $_.Exception.Message)
  Write-Result -Ok $false -Rollback $false -ErrorMessage ('installed {0} but could not start it: {1}' -f $cfg.version, $_.Exception.Message)
  exit 1
}

Start-Sleep -Seconds 2
if (Test-DshServer -Seconds 40) {
  Write-Log ('server is listening on port {0}' -f $cfg.port)
  Write-Result -Ok $true -Rollback $false -ErrorMessage ''
  Write-Log 'DONE'
  exit 0
}

Write-Log 'new server did not come up; rolling back to the previous version'
try { if ($null -ne $script:ServerProcess) { Stop-Process -Id $script:ServerProcess.Id -Force -ErrorAction SilentlyContinue } } catch { }

if ($profileTouched) { Restore-Profile }
Restore-Backup -BackupDir $backupDir
$rollbackExit = Invoke-NpmInstall -NpmArgs $restoreArgs -Tag 'rollback'
$restored = Get-PackageVersion -PackageJson $dshPackage
Write-Log ('rollback: exit {0}, package now {1}' -f $rollbackExit, $restored)

try { Start-DshServer } catch {
  Write-Log ('ERROR: could not restart the previous version: ' + $_.Exception.Message)
}
Write-Result -Ok $false -Rollback $true -ErrorMessage ('{0} did not start; rolled back to {1}' -f $cfg.version, $cfg.fromVersion)
exit 1
