/**
 * 只跑更新脚本的试运行（update-dsh.ps1 -DryRun）。
 *
 * 把一份 plan.json 按这台机器的真实布局写出来，让脚本念一遍：核心树在不在、
 * npm 在哪、启动入口指向哪、装的是哪一版。什么都不停、不装、不起，
 * 日志落在 tests/.dry/ 里，跑完就删。
 *
 *   node tests/dry-run.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = dirname(here)
const script = join(pluginDir, 'scripts', 'update-dsh.ps1')
const coreDir = process.env.DSH_CORE_DIR ?? 'E:\\dsh\\dsh'
const workDir = join(here, '.dry')

function fail(message) {
  console.error(`[dry-run] ${message}`)
  process.exit(1)
}

if (!existsSync(script)) fail(`找不到 ${script}`)
if (!existsSync(coreDir)) fail(`核心树不在：${coreDir}（可以用 DSH_CORE_DIR 指定）`)

const installedPackage = join(coreDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
if (!existsSync(installedPackage)) fail(`核心树里没有 @deepseek-ai/dsh：${installedPackage}`)
const installedVersion = JSON.parse(readFileSync(installedPackage, 'utf8')).version

rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

const plan = {
  // 0.0.0-test 只是给试运行念的：真更新时这里是 npm 上的版本号
  version: '0.0.0-test',
  fromVersion: installedVersion,
  coreDir,
  registry: 'https://registry.npmjs.org',
  npmPath: join(dirname(process.execPath), 'npm.cmd'),
  serverPid: 0,
  nodePath: process.execPath,
  entryPath: join(coreDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  argv: ['web'],
  workDir,
  port: 0,
  logDir: workDir,
  logFile: join(workDir, 'dry.log'),
  resultFile: join(workDir, 'last-update.json'),
  backupDir: join(workDir, 'backup-dry'),
  stopTimeoutSeconds: 45,
  timeoutSeconds: 900,
}

const planFile = join(workDir, 'plan-dry.json')
writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

const run = spawnSync('powershell.exe', [
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', script,
  '-Plan', planFile,
  '-DryRun',
], { encoding: 'utf8' })

if (run.error) {
  console.error(`[dry-run] 起不来 powershell：${run.error.code ?? run.error.message}`)
  if (run.error.code === 'EPERM' || run.error.code === 'EACCES') {
    console.error('[dry-run] 这是 DSH 沙盒的限制（沙盒里的进程不能再拉起 powershell）。请在本机的普通终端里跑：')
    console.error(`        node "${join(pluginDir, 'tests', 'dry-run.mjs')}"`)
  }
  process.exit(1)
}

if (run.stdout) process.stdout.write(run.stdout)
if (run.stderr) process.stderr.write(run.stderr)

const logFile = plan.logFile
console.log(`\n──── ${logFile} ────`)
console.log(existsSync(logFile) ? readFileSync(logFile, 'utf8') : '（脚本没写日志）')

if (run.status !== 0) {
  console.error(`\n[dry-run] 失败，退出码 ${run.status}`)
  process.exit(1)
}

const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
const missing = log.split('\n').filter((line) => line.includes('[MISS]'))
rmSync(workDir, { recursive: true, force: true })
if (missing.length > 0) {
  console.error(`\n[dry-run] plan 里有 ${missing.length} 个路径不存在：`)
  for (const line of missing) console.error(line)
  process.exit(1)
}
console.log('\n[dry-run] 通过：路径、npm、版本都对得上')
