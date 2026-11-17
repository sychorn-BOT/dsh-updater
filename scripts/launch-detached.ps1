<#
  dsh-updater -- detached launcher (CreateProcessW, breakaway from the host job)

  Why this exists: the host runs inside a Windows job (the sandbox), and a job
  whose handle closes takes every process still inside it down. A normally
  spawned child, and even a FreeConsole'd one, dies the moment the host exits --
  which is exactly when npm install must start running.

  libuv (node) cannot pass CREATE_BREAKAWAY_FROM_JOB, so this shim does the one
  native call the host cannot: CreateProcessW with

      CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP

  The host starts this shim the ordinary way (that works), reads the PID or the
  Win32 error from stdout, and the shim exits at once. The real script then runs
  outside the job and survives the host.

  Output:  PID:<n>        started
           FAIL:<code>    CreateProcessW refused (breakaway not allowed etc.)

  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArgLine,
  [string]$WorkDir = '',
  [string]$Marker = '',
  [string]$Exe = ''
)

$ErrorActionPreference = 'Stop'

if ($Marker -ne '') {
  try { Set-Content -LiteralPath $Marker -Value 'launcher-ran' -Encoding ASCII } catch { }
}

$signature = @'
using System;
using System.Runtime.InteropServices;

public static class DshBreakaway {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessW(
    string lpApplicationName,
    string lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFORMATION lpProcessInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr hProcess, IntPtr hJob, out bool inJob);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
}
'@

Add-Type -TypeDefinition $signature

$inJob = $false
try {
  [DshBreakaway]::IsProcessInJob([DshBreakaway]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob) | Out-Null
} catch { }

$startup = New-Object DshBreakaway+STARTUPINFO
$startup.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($startup)
$info = New-Object DshBreakaway+PROCESS_INFORMATION

# 0x01000000 CREATE_BREAKAWAY_FROM_JOB
# 0x00000200 CREATE_NEW_PROCESS_GROUP
#
# No DETACHED_PROCESS: on this machine a process created with that flag starts,
# gets a PID, and then executes nothing at all (same result as node's libuv
# detached spawn). The child keeps the console it inherits and the update script
# detaches from it itself with FreeConsole.
$flags = 0x01000000 -bor 0x00000200

$application = $Exe
if ($application -eq '') { $application = $null }

$directory = $WorkDir
if ($directory -eq '') { $directory = $null }

$ok = [DshBreakaway]::CreateProcessW(
  $application,
  $ArgLine,
  [IntPtr]::Zero,
  [IntPtr]::Zero,
  $true,
  $flags,
  [IntPtr]::Zero,
  $directory,
  [ref]$startup,
  [ref]$info)

if (-not $ok) {
  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Output ('FAIL:{0}:injob={1}' -f $code, $inJob)
  exit 1
}

# Watch the child for a moment: "got a PID" alone does not mean it runs. If it
# dies right away, its exit code (negative = 0xC0000000 style NTSTATUS) is the
# most useful thing we can report.
$waited = [DshBreakaway]::WaitForSingleObject($info.hProcess, 1500)
$exited = $false
$exitCode = 0
if ($waited -eq 0) {
  $exited = $true
  try { [DshBreakaway]::GetExitCodeProcess($info.hProcess, [ref]$exitCode) | Out-Null } catch { }
}
try { [DshBreakaway]::CloseHandle($info.hThread) | Out-Null } catch { }
try { [DshBreakaway]::CloseHandle($info.hProcess) | Out-Null } catch { }

Write-Output ('PID:{0}:injob={1}:exited={2}:exit={3}' -f $info.dwProcessId, $inJob, $exited, $exitCode)
exit 0
