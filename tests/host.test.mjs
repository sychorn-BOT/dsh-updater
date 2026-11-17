// 本地验收脚本：不装进 profile，只用来跑宿主半侧的逻辑
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, compareVersions, detachedInBootstrap } from '../lib/index.js'

// 用宿主自己的校验器过一遍 schema —— 线上 tools.register() 走的就是这个函数。
// 它的子集比 JSON Schema 窄（type 只认单个字符串），写宽了注册会直接抛错，
// 而插件是「挂了但悄悄少个工具」：徽标照常工作，模型那边看不见工具。
const coreDir = process.env.DSH_CORE_DIR ?? 'E:/dsh/dsh'
let assertSupportedJsonSchema = null
try {
  const tools = await import(new URL(`file:///${coreDir.replace(/\\/g, '/')}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`).href)
  assertSupportedJsonSchema = tools.assertSupportedJsonSchema
} catch (error) {
  console.log(`（跳过真校验器：${error?.message ?? error}）`)
}

const checks = []
function ok(name, condition, detail) {
  checks.push({ name, pass: Boolean(condition), detail })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── 版本比较 ────────────────────────────────────────────────
ok('0.2.2-rc.1 > 0.2.1-rc.5', compareVersions('0.2.2-rc.1', '0.2.1-rc.5') === 1)
ok('0.2.1-rc.5 > 0.2.1-rc.4', compareVersions('0.2.1-rc.5', '0.2.1-rc.4') === 1)
ok('0.2.1 > 0.2.1-rc.5 (release 大于预发布)', compareVersions('0.2.1', '0.2.1-rc.5') === 1)
ok('0.2.1-rc.5 < 0.2.1-rc.10 (数字段按数值)', compareVersions('0.2.1-rc.5', '0.2.1-rc.10') === -1)
ok('0.2.2-alpha.3 < 0.2.2-rc.1', compareVersions('0.2.2-alpha.3', '0.2.2-rc.1') === -1)
ok('相等', compareVersions('0.2.1-rc.5', '0.2.1-rc.5') === 0)
ok('垃圾版本号返回 null', compareVersions('abc', '0.2.1') === null)

// ── 装配：用假 ctx 跑真实的注册路径 ────────────────────────
// 模拟真实启动命令的 process.argv[1]，让「顺着启动入口找包」走真代码
const realEntry = 'E:/dsh/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
process.argv[1] = realEntry

const registered = { routes: [], tools: [] }
const ctx = {
  get: () => undefined,
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  webServer: { register: (route) => { registered.routes.push(route); return () => {} } },
  tools: {
    register: (definition) => {
      // 真注册器先校验 output.schema；这里照做，schema 写错就让测试炸
      assertSupportedJsonSchema?.(definition.output.schema)
      registered.tools.push(definition)
      return () => {}
    },
  },
}
const root = { inject: (_list, run) => run(ctx) }

apply(root, { channel: 'latest' })
ok('注册了状态路由和更新路由', registered.routes.length === 2
  && registered.routes.some((r) => r.path === '/dsh-updater/status')
  && registered.routes.some((r) => r.path === '/dsh-updater/update'),
  registered.routes.map((r) => `${r.kind} ${r.path}`).join(','))
const toolNames = registered.tools.map((tool) => tool.name)
ok('注册了查更新和自检两个工具',
  toolNames.includes('dsh_check_update') && toolNames.includes('dsh_update_doctor'), toolNames.join(','))

let schemaError = null
try {
  for (const tool of registered.tools) {
    assertSupportedJsonSchema?.(tool.output.schema)
    assertSupportedJsonSchema?.(tool.parameters)
  }
} catch (error) {
  schemaError = error
}
ok('参数和输出 schema 都在宿主支持的子集里', schemaError === null, schemaError?.message)

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
      this.done = true
      this.finish?.()
    },
  }
  res.settled = new Promise((resolvePromise) => { res.finish = resolvePromise })
  return res
}

/** 注册进去的 handler 不返回 promise（它自己 catch），所以等 res.end 被调用。 */
async function callRoute(route, req) {
  const res = fakeRes()
  route.handler(req, res)
  const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('route did not answer in 20s')), 20_000))
  await Promise.race([res.settled, timeout])
  return res
}

const route = registered.routes.find((r) => r.path === '/dsh-updater/status')
const res = await callRoute(route, { method: 'GET', url: '/dsh-updater/status' })
const payload = JSON.parse(res.body)
ok('路由返回 200 且是 JSON', res.statusCode === 200 && res.headers['content-type'].includes('application/json'))
ok('读到了本机安装版本', typeof payload.installed === 'string', `installed=${payload.installed}`)
ok('读到了包位置', typeof payload.installedFile === 'string', payload.installedFile)
ok('查到了 npm 上的 latest', typeof payload.latest === 'string', `latest=${payload.latest} channel=${payload.channel}`)
ok('顺带带回其它标签', payload.channels && Object.keys(payload.channels).length > 0, JSON.stringify(payload.channels))
ok('updateAvailable 和版本比较一致',
  payload.updateAvailable === (compareVersions(payload.latest, payload.installed) === 1),
  `installed=${payload.installed} latest=${payload.latest} updateAvailable=${payload.updateAvailable} ahead=${payload.ahead}`)
ok('summary 有内容', typeof payload.summary === 'string' && payload.summary.length > 0, JSON.stringify(payload.summary))
ok('真核心树报得出自动更新能力', payload.canAutoUpdate === true, `blockedBy=${payload.updateBlockedBy}`)

// 缓存：第二次不该再打网络（用 cached 标记验证）
const res2 = await callRoute(route, { method: 'GET', url: '/dsh-updater/status' })
const payload2 = JSON.parse(res2.body)
ok('第二次命中宿主缓存', payload2.cached === true)

// 非 GET 拒绝
const res3 = await callRoute(route, { method: 'POST', url: '/dsh-updater/status' })
ok('POST /status 被 405 拒掉', res3.statusCode === 405, res3.body)

// 工具走的是同一份逻辑
const toolResult = await registered.tools[0].execute({ refresh: true })
ok('工具能跑通', toolResult?.ok === true && typeof toolResult.installed === 'string',
  `installed=${toolResult?.installed} latest=${toolResult?.latest} updateAvailable=${toolResult?.updateAvailable}`)
ok('工具带 summary', typeof toolResult?.summary === 'string')
const rendered = registered.tools[0].output.render({}, toolResult)
ok('工具渲染成文本', Array.isArray(rendered) && rendered[0]?.type === 'text')

// 未知 channel 回退成 latest
const fallback = { routes: [], tools: [] }
const emptyCtx = {
  get: () => undefined,
  effect: (fn) => fn(),
  webServer: { register: (route2) => { fallback.routes.push(route2); return () => {} } },
  tools: { register: (definition) => { fallback.tools.push(definition); return () => {} } },
}
apply({ inject: (_l, run) => run(emptyCtx) }, { channel: 'nope' })
const res4 = await callRoute(fallback.routes[0], { method: 'GET', url: '/dsh-updater/status' })
ok('非法 channel 回退成 latest', JSON.parse(res4.body).channel === 'latest')

// 启动入口是假的（读不到 package.json）时，退回宿主 release，并照样给出结论
const savedArgv = process.argv[1]
process.argv[1] = 'C:/nowhere/entry.js'
const releaseRoutes = []
const releaseCtx = {
  get: (name) => (name === 'clientModules' ? { graph: () => ({ release: { version: '0.2.1-rc.5' } }) } : undefined),
  effect: (fn) => fn(),
  webServer: { register: (route2) => { releaseRoutes.push(route2); return () => {} } },
  tools: { register: () => () => {} },
}
apply({ inject: (_l, run) => run(releaseCtx) }, {})
const statusRoute5 = releaseRoutes.find((r) => r.path === '/dsh-updater/status')
const res5 = await callRoute(statusRoute5, { method: 'GET', url: '/dsh-updater/status' })
const payload5 = JSON.parse(res5.body)
ok('启动入口读不到时退回 host release', payload5.installed === '0.2.1-rc.5' && payload5.installedSource === 'host-release',
  `installed=${payload5.installed} source=${payload5.installedSource}`)
ok('这种装法不给自动更新', payload5.canAutoUpdate === false && payload5.updateBlockedBy === 'installed unknown',
  `blockedBy=${payload5.updateBlockedBy}`)

/* ─────────────────────────── 更新流程 ─────────────────────────── */
// 用一个假的核心树，别去碰真的 E:\dsh\dsh。版本写成 0.0.1，保证 npm 上总有更新的。
const fakeCore = fileURLToPath(new URL('./.tmp/fake-core/', import.meta.url))
rmSync(fakeCore, { recursive: true, force: true })
mkdirSync(join(fakeCore, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
writeFileSync(join(fakeCore, 'package.json'), JSON.stringify({
  name: 'dsh-next', private: true, version: '1.0.0', dependencies: { '@deepseek-ai/dsh': '0.0.1' },
}, null, 2))
writeFileSync(join(fakeCore, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({
  name: '@deepseek-ai/dsh', version: '0.0.1',
}, null, 2))
const fakeEntry = join(fakeCore, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
writeFileSync(fakeEntry, '// fake entry\n')

process.argv[1] = fakeEntry
const updateRoutes = []
const updateCtx = {
  get: () => undefined,
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  webServer: { register: (route2) => { updateRoutes.push(route2); return () => {} } },
  tools: { register: () => () => {} },
}
let prepared = null
const shutdowns = []

/** 正常机器上的自检结果：powershell 能拉起（exit 7），npm 能报版本。 */
const healthyPreflight = async () => ({
  powershell: { ok: true, code: 7, error: null, stderr: '' },
  npm: { ok: true, code: 0, version: '10.9.0', error: null, stderr: '' },
  script: { ok: true, code: 0, error: null, stderr: '' },
})

apply({ inject: (_l, run) => run(updateCtx) }, {
  channel: 'latest',
  preflight: healthyPreflight,
  verifyStarted: async () => ({ ok: true, error: null }),
  spawnUpdate: (plan) => { prepared = plan; return { pid: 4242 } },
  shutdown: async (nodeCtx) => { shutdowns.push(nodeCtx ?? null) },
  shutdownDelayMs: 80,
})

const updateRoute = updateRoutes.find((r) => r.path === '/dsh-updater/update')
const updateStatusRoute = updateRoutes.find((r) => r.path === '/dsh-updater/status')
ok('更新进程里也注册了 /dsh-updater/update', updateRoute !== undefined)

const statusNow = JSON.parse((await callRoute(updateStatusRoute, { method: 'GET', url: '/dsh-updater/status' })).body)
ok('假核心树能被识别并给出可更新', statusNow.canAutoUpdate === true && statusNow.updateAvailable === true,
  `installed=${statusNow.installed} latest=${statusNow.latest} blockedBy=${statusNow.updateBlockedBy}`)

// 没带那个请求头：不能凭一个 POST 就开始装包
const resNoHeader = await callRoute(updateRoute, { method: 'POST', url: '/dsh-updater/update', headers: {}, resume() {} })
ok('缺少确认头时被 400 拒掉', resNoHeader.statusCode === 400, resNoHeader.body)

// 正常路径
const resUpdate = await callRoute(updateRoute, {
  method: 'POST',
  url: '/dsh-updater/update',
  headers: { 'x-dsh-updater-action': 'update' },
  resume() {},
})
const updatePayload = JSON.parse(resUpdate.body)
ok('POST 开始更新', resUpdate.statusCode === 200 && updatePayload.ok === true, resUpdate.body)
ok('装的就是 npm 上那个版本', updatePayload.target === statusNow.latest, `${updatePayload.target} vs ${statusNow.latest}`)
ok('带上这次更新的起点', updatePayload.from === '0.0.1', updatePayload.from)
ok('宿主把执行器拉起来了', prepared !== null && typeof prepared.planFile === 'string')
ok('plan.json 落在核心树里', prepared !== null && prepared.planFile.startsWith(fakeCore), prepared?.planFile)
ok('plan.json 真写出来了', prepared !== null && existsSync(prepared.planFile))
const planJson = prepared === null ? null : JSON.parse(readFileSync(prepared.planFile, 'utf8'))
ok('plan 里的版本和接口回的一致', planJson?.version === updatePayload.target, planJson?.version)
ok('plan 里写的是核心树路径', resolve(planJson?.coreDir ?? '') === resolve(fakeCore), planJson?.coreDir)
ok('plan 里带着宿主的 pid', planJson?.serverPid === process.pid, String(planJson?.serverPid))
ok('plan 里带着重启参数', planJson?.entryPath === resolve(fakeEntry) && Array.isArray(planJson?.argv)
  && JSON.stringify(planJson.argv) === JSON.stringify(process.argv.slice(2)),
  `${planJson?.entryPath} ${JSON.stringify(planJson?.argv)}`)
ok('plan 里给出日志和备份位置', typeof planJson?.logFile === 'string' && planJson.logFile.startsWith(fakeCore)
  && typeof planJson?.backupDir === 'string' && planJson.backupDir.startsWith(fakeCore))
ok('plan 里带上 npm 和超时', typeof planJson?.npmPath === 'string' && planJson?.timeoutSeconds > 0)

const resPhase = await callRoute(updateRoute, { method: 'GET', url: '/dsh-updater/update' })
const phasePayload = JSON.parse(resPhase.body)
ok('更新状态接口说正在安排', phasePayload.phase === 'scheduled' && phasePayload.target === updatePayload.target, resPhase.body)

// 第二次点：不许排队
const resAgain = await callRoute(updateRoute, {
  method: 'POST',
  url: '/dsh-updater/update',
  headers: { 'x-dsh-updater-action': 'update' },
  resume() {},
})
ok('重复点击被 409 拒掉', resAgain.statusCode === 409, resAgain.body)

await new Promise((resolveWait) => setTimeout(resolveWait, 160))
ok('安排完以后宿主会自己退场', shutdowns.length === 1, `shutdown 调用 ${shutdowns.length} 次`)

// 上次更新的结论：脚本写的那份 result 文件，重启后由状态接口读回来
mkdirSync(join(fakeCore, '.dsh-updater'), { recursive: true })
writeFileSync(join(fakeCore, '.dsh-updater', 'last-update.json'), JSON.stringify({
  ok: false, running: false, from: '0.0.1', to: '9.9.9',
  at: '2026-11-15T01:00:00Z', rollback: true, error: 'npm install failed', logFile: 'x.log',
}, null, 2))
const lastPayload = JSON.parse((await callRoute(updateStatusRoute, { method: 'GET', url: '/dsh-updater/status?refresh=1' })).body)
ok('状态接口带回上次更新的结论', lastPayload.lastUpdate?.to === '9.9.9' && lastPayload.lastUpdate?.rollback === true,
  JSON.stringify(lastPayload.lastUpdate))

/* ───────────────── 两个「别把服务白停掉」的护栏 ───────────────── */

async function freshUpdateInstance(options) {
  const routes = []
  const state = { shutdowns: 0 }
  const instanceCtx = {
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    webServer: { register: (route2) => { routes.push(route2); return () => {} } },
    tools: { register: () => () => {} },
  }
  apply({ inject: (_l, run) => run(instanceCtx) }, {
    channel: 'latest',
    shutdownDelayMs: 60,
    preflight: healthyPreflight,
    verifyStarted: async () => ({ ok: true, error: null }),
    ...options,
    shutdown: async () => { state.shutdowns += 1 },
  })
  return {
    state,
    start: routes.find((r) => r.path === '/dsh-updater/update'),
    status: routes.find((r) => r.path === '/dsh-updater/status'),
  }
}

const postUpdate = (route2) => callRoute(route2, {
  method: 'POST',
  url: '/dsh-updater/update',
  headers: { 'x-dsh-updater-action': 'update' },
  resume() {},
})

// 1. powershell 压根没起来：报错，但不许退场
const guardNoPid = await freshUpdateInstance({ spawnUpdate: () => ({ pid: null }) })
const resNoPid = await postUpdate(guardNoPid.start)
ok('执行器没起来时直接报错', resNoPid.statusCode === 500 && JSON.parse(resNoPid.body).error.includes('没起来'),
  resNoPid.body)
await new Promise((resolveWait) => setTimeout(resolveWait, 140))
ok('执行器没起来时宿主不退场', guardNoPid.state.shutdowns === 0, `shutdown ${guardNoPid.state.shutdowns} 次`)

// 2. 脚本起来了、但马上死了：同样不许退场，并且把失败写进状态
const earlyExit = new EventEmitter()
const guardEarly = await freshUpdateInstance({ spawnUpdate: () => ({ pid: 777, child: earlyExit }) })
const resEarly = await postUpdate(guardEarly.start)
ok('脚本起来了就先答应客户端', resEarly.statusCode === 200 && JSON.parse(resEarly.body).phase === 'scheduled', resEarly.body)
earlyExit.emit('exit', 1, null)
await new Promise((resolveWait) => setTimeout(resolveWait, 160))
ok('脚本提前退出时宿主不退场', guardEarly.state.shutdowns === 0, `shutdown ${guardEarly.state.shutdowns} 次`)
const earlyPhase = JSON.parse((await callRoute(guardEarly.start, { method: 'GET', url: '/dsh-updater/update' })).body)
ok('状态接口说这次更新没成', earlyPhase.phase === 'failed' && String(earlyPhase.error).includes('提前退出'),
  JSON.stringify(earlyPhase))

// 3. 环境自检不过（宿主拉不起 powershell）：不写计划、不退场
const planDirBefore = readdirSync(join(fakeCore, '.dsh-updater')).filter((name) => name.startsWith('plan-')).length
const guardNoShell = await freshUpdateInstance({
  preflight: async () => ({
    powershell: { ok: false, code: null, error: 'EPERM' },
    npm: { ok: true, code: 0, version: '10.9.0', error: null },
    script: { ok: false, code: null, error: 'powershell 没起来，没跑脚本', stderr: null },
  }),
  spawnUpdate: () => { throw new Error('自检不过不该去拉执行器') },
})
const resNoShell = await postUpdate(guardNoShell.start)
const noShellPayload = JSON.parse(resNoShell.body)
ok('自检不过时点更新直接报错', resNoShell.statusCode === 503 && noShellPayload.error.includes('EPERM'), resNoShell.body)
const planDirAfter = readdirSync(join(fakeCore, '.dsh-updater')).filter((name) => name.startsWith('plan-')).length
ok('自检不过时不留下 update plan', planDirAfter === planDirBefore, `${planDirBefore} → ${planDirAfter}`)
await new Promise((resolveWait) => setTimeout(resolveWait, 140))
ok('自检不过时宿主不退场', guardNoShell.state.shutdowns === 0, `shutdown ${guardNoShell.state.shutdowns} 次`)

// 3b. 脚本自己能跑：powershell 和 npm 都行，但 .ps1 跑不起来（执行策略/杀软）
const guardNoScript = await freshUpdateInstance({
  preflight: async () => ({
    powershell: { ok: true, code: 7, error: null, stderr: '' },
    npm: { ok: true, code: 0, version: '10.9.0', error: null, stderr: '' },
    script: {
      ok: false,
      code: 1,
      error: '退出码 1',
      stderr: 'File E:\\dsh\\plugins\\dsh-updater\\scripts\\update-dsh.ps1 cannot be loaded because running scripts is disabled on this system.',
    },
  }),
  spawnUpdate: () => { throw new Error('脚本跑不起来不该去拉执行器') },
})
const resNoScript = await postUpdate(guardNoScript.start)
const noScriptPayload = JSON.parse(resNoScript.body)
ok('脚本跑不起来时也直接报错', resNoScript.statusCode === 503
  && noScriptPayload.error.includes('running scripts is disabled'), resNoScript.body)
ok('脚本报错时也不退场', guardNoScript.state.shutdowns === 0, `shutdown ${guardNoScript.state.shutdowns} 次`)

// 4. 自检工具本身：条件齐了 / 差在哪
const doctorTools = []
apply({ inject: (_l, run) => run({
  get: () => undefined,
  effect: (fn) => fn(),
  webServer: { register: () => () => {} },
  tools: { register: (definition) => { doctorTools.push(definition); return () => {} } },
}) }, { channel: 'latest', preflight: healthyPreflight })
const doctorTool = doctorTools.find((tool) => tool.name === 'dsh_update_doctor')
const doctorValue = await doctorTool.execute({})
ok('自检工具说条件齐了', doctorValue.canAutoUpdate === true && doctorValue.powershellOk === true
  && doctorValue.npmOk === true && doctorValue.scriptOk === true && doctorValue.blockedBy === null
  && String(doctorValue.summary).includes('条件齐了'), JSON.stringify(doctorValue.summary))

const brokenTools = []
apply({ inject: (_l, run) => run({
  get: () => undefined,
  effect: (fn) => fn(),
  webServer: { register: () => () => {} },
  tools: { register: (definition) => { brokenTools.push(definition); return () => {} } },
}) }, {
  channel: 'latest',
  preflight: async () => ({
    powershell: { ok: false, code: null, error: 'EPERM' },
    npm: { ok: true, code: 0, version: '10.9.0', error: null },
    script: { ok: false, code: null, error: 'powershell 没起来，没跑脚本', stderr: null },
  }),
})
const brokenValue = await brokenTools.find((tool) => tool.name === 'dsh_update_doctor').execute({})
ok('自检工具指出 powershell 拉不起来', brokenValue.powershellOk === false && String(brokenValue.summary).includes('EPERM')
  && String(brokenValue.summary).includes('先解决'), JSON.stringify(brokenValue.summary))

/* ───────────────── 插件兼容闸门 ───────────────── */
// 造一个假 home：profile 里挂两个 bundle，其中一个声明了「不认目标核心」的要求。
// app-boot 的判定用一个桩替身（真判定函数太大，这里只验闸门的接线）。
const fakeHome = fileURLToPath(new URL('./.tmp/fake-home/', import.meta.url))
const fakeProfile = join(fakeHome, 'profiles', 'web')
mkdirSync(join(fakeProfile, 'node_modules', 'good-plugin'), { recursive: true })
mkdirSync(join(fakeProfile, 'node_modules', 'bad-plugin'), { recursive: true })
writeFileSync(join(fakeProfile, 'package.json'), JSON.stringify({
  name: 'fake-profile', private: true, dsh: { profile: { bundles: ['good-plugin', 'bad-plugin', 'dsh-ops'] } },
}, null, 2))
writeFileSync(join(fakeProfile, 'node_modules', 'good-plugin', 'package.json'), JSON.stringify({
  name: 'good-plugin', version: '1.0.0',
}, null, 2))
writeFileSync(join(fakeProfile, 'node_modules', 'bad-plugin', 'package.json'), JSON.stringify({
  name: 'bad-plugin', version: '9.9.9', engines: { dsh: 'BLOCK' },
}, null, 2))
// 真在 npm 上的包：桩判定说它「不认」当前目标，但 registry 上的 latest 能认——
// 这就是 dsh-ops 那种「升一版就能配新核心」的情况。
mkdirSync(join(fakeProfile, 'node_modules', 'dsh-ops'), { recursive: true })
writeFileSync(join(fakeProfile, 'node_modules', 'dsh-ops', 'package.json'), JSON.stringify({
  name: 'dsh-ops', version: '0.4.4', engines: { dsh: 'BLOCK' },
}, null, 2))

// 假核心树旁边放一个 app-boot 桩：engines.dsh === 'BLOCK' 就算不兼容
const stubDir = join(fakeCore, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib')
mkdirSync(stubDir, { recursive: true })
writeFileSync(join(stubDir, 'index.js'), [
  'export function evaluatePluginCompatibility(manifest, exemptions, runtimeVersion) {',
  "  const range = manifest?.engines?.dsh",
  "  if (range === 'BLOCK') return { name: manifest.name, version: manifest.version, runtimeVersion, requirements: { 'engines.dsh': range }, exempted: false }",
  '  return undefined',
  '}',
  '',
].join('\n'))

const savedHome = process.env.DSH_HOME
process.env.DSH_HOME = fakeHome
const gateTools = []
apply({ inject: (_l, run) => run({
  get: () => undefined,
  effect: (fn) => fn(),
  webServer: { register: () => () => {} },
  tools: { register: (definition) => { gateTools.push(definition); return () => {} } },
}) }, { channel: 'latest' })   // 不注入 preflight：跑真的，闸门在它开头
const gateValue = await gateTools.find((tool) => tool.name === 'dsh_update_doctor').execute({})
process.env.DSH_HOME = savedHome

ok('闸门查出挡路的插件', gateValue.pluginsOk === false
  && String(gateValue.pluginsBlocked).includes('bad-plugin@9.9.9'), JSON.stringify(gateValue.pluginsBlocked))
ok('闸门放过了兼容的插件', !String(gateValue.pluginsBlocked).includes('good-plugin'))
ok('闸门数了检查过几个', gateValue.pluginsChecked === 3, String(gateValue.pluginsChecked))
ok('闸门给挡路的插件找了可升级版本', String(gateValue.pluginsUpgrades).includes('dsh-ops 0.4.4 → 0.5.5'), String(gateValue.pluginsUpgrades))
ok('自检总述里点名挡路的插件', String(gateValue.summary).includes('插件兼容'), JSON.stringify(gateValue.summary))

process.argv[1] = savedArgv
rmSync(fileURLToPath(new URL('./.tmp/', import.meta.url)), { recursive: true, force: true })

// ── bootstrap 里的 detach 判定 ─────────────────────────────
const bootLine = '[23:30:16] start pid=1 plan=E:/x/plan-20261115-233016.json\n'
ok('detach 在 plan 行之后才算数',
  detachedInBootstrap(bootLine + '[23:30:17] detach freeconsole=True\n', 'plan-20261115-233016.json') === true)
ok('没有控制台也算脱离',
  detachedInBootstrap(bootLine + '[23:30:17] detach noconsol=True\n', 'plan-20261115-233016.json') === true)
ok('旧运行的 detach 不能替新这次作证',
  detachedInBootstrap('[23:00:00] detach freeconsole=True\n' + bootLine, 'plan-20261115-233016.json') === false)
ok('detach 失败要认出来',
  detachedInBootstrap(bootLine + '[23:30:17] detach FAILED: x\n', 'plan-20261115-233016.json') === false)
ok('没有这只 plan 就是没跑', detachedInBootstrap(bootLine, 'plan-other.json') === false)

const failed = checks.filter((c) => !c.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length > 0) process.exitCode = 1
