/**
 * 真跑一遍更新脚本，只看它留下的进度记录。
 *
 * 造一棵假核心树：npm 换成自己写的小脚本（把 package.json 里的版本改掉就算装好了），
 * DSH 换成一个小进程（活着就够），端口给 0（不用真监听）。所以它不会碰这台机器上
 * 真的 DSH，也不会装任何东西。
 *
 * 这一条要 powershell，所以单独跑，不进 npm test：
 *   node tests/script-flow.mjs
 *
 * 验的是 JS 和 PowerShell 之间那个缝：脚本写的 last-update.json 到底长什么样、
 * 宿主半侧的 reader 读不读得回来（BOM、步骤、百分比、耗时）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLastUpdate } from '../lib/index.js'

const root = fileURLToPath(new URL('./.tmp/script-flow/', import.meta.url))
const script = fileURLToPath(new URL('../scripts/update-dsh.ps1', import.meta.url))

const checks = []
function ok(name, condition, detail) {
  checks.push({ name, pass: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 假 npm：cwd 就是核心树，把 @deepseek-ai/dsh@X 的版本改成 X；不带版本号就是还原。
 * npm-delay 里有数字就等那么久（好让测试抓到「正在装」那一刻），npm-fails 在就直接失败。
 */
const FAKE_NPM = String.raw`
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const core = process.cwd()
const target = join(core, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const args = process.argv.slice(2)
const spec = args[1] ?? ''
const version = (/@deepseek-ai\/dsh@(.+)$/.exec(spec) ?? [])[1] ?? '0.0.1'
if (existsSync(join(__dirname, 'npm-delay'))) {
  setTimeout(finish, Number(readFileSync(join(__dirname, 'npm-delay'), 'utf8')))
} else {
  finish()
}
function finish() {
  if (spec.startsWith('@deepseek-ai/dsh@') && existsSync(join(__dirname, 'npm-fails'))) {
    console.error('fake npm: simulated install failure')
    process.exit(1)
  }
  const json = JSON.parse(readFileSync(target, 'utf8'))
  json.version = version
  writeFileSync(target, JSON.stringify(json, null, 2))
  process.exit(0)
}
`

/** 假的 DSH：进程活着，Test-DshServer 就认为它起来了。 */
const FAKE_ENTRY = 'setTimeout(() => process.exit(0), 60000)\n'

/** 造一棵假核心树 + 一份 plan。返回 plan 的路径。 */
function prepare(name, { slow = false, failing = false } = {}) {
  const dir = join(root, name)
  const core = join(dir, 'core')
  const packageDir = join(core, 'node_modules', '@deepseek-ai', 'dsh')
  const state = join(core, '.dsh-updater')
  for (const target of [core, packageDir, state]) mkdirSync(target, { recursive: true })
  writeFileSync(join(core, 'package.json'), JSON.stringify({
    name: 'fake-core', private: true, version: '1.0.0', dependencies: { '@deepseek-ai/dsh': '0.0.1' },
  }, null, 2))
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.0.1',
  }, null, 2))
  writeFileSync(join(dir, 'fake-npm.cjs'), FAKE_NPM)
  writeFileSync(join(dir, 'fake-entry.cjs'), FAKE_ENTRY)
  if (slow) writeFileSync(join(dir, 'npm-delay'), '700')
  if (failing) writeFileSync(join(dir, 'npm-fails'), '1')

  const plan = {
    version: '0.0.2-test',
    fromVersion: '0.0.1',
    coreDir: core,
    registry: 'https://registry.npmjs.org',
    npmPath: null,
    npmCli: join(dir, 'fake-npm.cjs'),
    serverPid: 999999,
    nodePath: process.execPath,
    entryPath: join(dir, 'fake-entry.cjs'),
    argv: [],
    workDir: core,
    port: 0,
    logDir: state,
    logFile: join(state, 'update-test.log'),
    resultFile: join(state, 'last-update.json'),
    backupDir: join(state, 'backup'),
    stopTimeoutSeconds: 2,
    timeoutSeconds: 90,
    profileDir: null,
    plugins: [],
    pnpmCli: null,
  }
  const planFile = join(state, 'plan.json')
  writeFileSync(planFile, JSON.stringify(plan, null, 2))
  return { planFile, plan, core, dir }
}

/** 起一个 powershell 跑更新脚本；返回 { done }（done 等它退出的 exit code 和输出）。 */
function startScript(planFile) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Plan', planFile,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout?.on('data', (chunk) => { output += chunk })
  child.stderr?.on('data', (chunk) => { output += chunk })
  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, output: String(error) }))
    child.on('exit', (code) => resolve({ code: code === null ? -1 : code, output }))
  })
  return { child, done }
}

/** 脚本起的那个假 DSH 会一直活着，收尾时按日志里的 pid 干掉它。 */
function killFakeServer(core) {
  try {
    const log = readFileSync(join(core, '.dsh-updater', 'update-test.log'), 'utf8')
    const match = /server pid\s*:\s*(\d+)/.exec(log)
    if (match !== null) process.kill(Number(match[1]))
  } catch { /* 已经走了 */ }
}

function versionOnDisk(core) {
  try {
    return JSON.parse(readFileSync(join(core, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

/* ───────────────── 一路顺利：四步都记下来 ───────────────── */

rmSync(root, { recursive: true, force: true })
const good = prepare('ok', { slow: true })

// 起脚本，同时盯着磁盘：跑到 npm 那一步时应该有一份 running 的快照
const running = startScript(good.planFile)
let snapshot = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  const value = readLastUpdate(good.core)
  if (value !== null && value.running === true && value.step === 'install') {
    snapshot = value
    break
  }
  await sleep(100)
}
const goodRun = await running.done
killFakeServer(good.core)
ok('脚本跑完了（exit 0）', goodRun.code === 0, `exit ${goodRun.code} ${goodRun.output.trim().slice(0, 200)}`)

const record = readLastUpdate(good.core)
ok('记录读得回来（PowerShell 的 BOM 没把 JSON.parse 弄挂）', record !== null, String(record))
ok('记录说这次成功了', record?.ok === true && record?.running === false && record?.rollback === false,
  JSON.stringify({ ok: record?.ok, running: record?.running, rollback: record?.rollback }))
ok('记录里是这次的两个版本', record?.from === '0.0.1' && record?.to === '0.0.2-test',
  `${record?.from} → ${record?.to}`)
ok('四步一步不少',
  JSON.stringify(record?.steps?.map((step) => step.id)) === JSON.stringify(['stop', 'backup', 'install', 'start']),
  JSON.stringify(record?.steps?.map((step) => step.id)))
ok('每一步都有耗时', (record?.steps ?? []).every((step) => Number.isFinite(step.ms) && step.ms >= 0),
  JSON.stringify(record?.steps?.map((step) => step.ms)))
ok('条子能算到 100%', record?.percent === 100, String(record?.percent))
ok('总耗时就是各步之和', record?.elapsedMs === record?.steps?.reduce((sum, step) => sum + step.ms, 0), String(record?.elapsedMs))
ok('核心树里的版本真换掉了', versionOnDisk(good.core) === '0.0.2-test', String(versionOnDisk(good.core)))
ok('npm 的输出被单独收了', existsSync(join(good.core, '.dsh-updater', 'npm-install-out.log')))

ok('跑到 npm 那一步时记录是 running', snapshot !== null
  && snapshot.running === true
  && snapshot.step === 'install'
  && JSON.stringify(snapshot.steps.map((step) => step.id)) === JSON.stringify(['stop', 'backup']),
  JSON.stringify(snapshot === null ? null : { step: snapshot.step, steps: snapshot.steps.map((step) => step.id) }))
ok('中途就写了总步数', snapshot?.total === 4, String(snapshot?.total))

/* ───────────────── 装失败：记录说 rollback，条子停在装核心 ───────────────── */

const bad = prepare('fail', { failing: true })
const badRun = await startScript(bad.planFile).done
killFakeServer(bad.core)

ok('装失败时脚本 exit 1', badRun.code === 1, `exit ${badRun.code}`)
const failed = readLastUpdate(bad.core)
ok('记录说这次没成、已经回滚', failed?.ok === false && failed?.running === false && failed?.rollback === true,
  JSON.stringify({ ok: failed?.ok, running: failed?.running, rollback: failed?.rollback }))
ok('记录点名卡在装核心', failed?.step === 'install', String(failed?.step))
ok('失败时只记着装之前的那两步',
  JSON.stringify(failed?.steps?.map((step) => step.id)) === JSON.stringify(['stop', 'backup']),
  JSON.stringify(failed?.steps?.map((step) => step.id)))
ok('失败时条子只走到一半', failed?.percent === 50, String(failed?.percent))
ok('失败原因里带着 exit', String(failed?.error).includes('npm install failed'), String(failed?.error))
ok('回滚把版本还原了', versionOnDisk(bad.core) === '0.0.1', String(versionOnDisk(bad.core)))

rmSync(root, { recursive: true, force: true })

const broken = checks.filter((check) => !check.pass)
console.log(`\n${checks.length - broken.length}/${checks.length} 通过`)
if (broken.length > 0) process.exitCode = 1
