/**
 * dsh-updater —— 宿主半侧
 *
 * 三件事：
 *   1. 读出这台机器上装的是哪一版 @deepseek-ai/dsh（不靠猜，顺着启动入口往上找 package.json）
 *   2. 去 npm 要一次 dist-tags，比出「有没有新版本」
 *   3. 用户点了「现在更新」以后，把安装计划写成 plan.json，拉起 scripts/update-dsh.ps1，
 *      自己退场——剩下停服务、npm install、回滚、重启都由那个脚本做完
 *
 * 对外开的口子：
 *   GET  /dsh-updater/status   浏览器半侧（徽标 + 弹窗）用，同时也带上次更新的结论
 *   GET  /dsh-updater/update   更新进行到哪一步（只活到进程退出那一刻）
 *   POST /dsh-updater/update   用户选了「是」
 *   tool dsh_check_update      模型自己想知道的时候用
 *
 * 读接口没有写操作。写只发生在用户点了「现在更新」以后：一次 plan.json、
 * 一个后台进程，然后整个宿主退出重启。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE = '@deepseek-ai/dsh'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_CACHE_SECONDS = 600
const REQUEST_TIMEOUT_MS = 8000
const CHANNELS = ['latest', 'next', 'alpha']

/** 更新脚本和它用的工作目录：都跟着核心树走，好找也好清理。 */
const UPDATE_SCRIPT = fileURLToPath(new URL('../scripts/update-dsh.ps1', import.meta.url))
const UPDATE_DIRNAME = '.dsh-updater'
const LAUNCH_SCRIPT = fileURLToPath(new URL('../scripts/launch-detached.ps1', import.meta.url))
const SHUTDOWN_DELAY_MS = 1200
const STOP_TIMEOUT_SECONDS = 45
const INSTALL_TIMEOUT_SECONDS = 900

/* ─────────────────────────── 配置 ─────────────────────────── */

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const channel = CHANNELS.includes(raw.channel) ? raw.channel : 'latest'
  const registry = typeof raw.registry === 'string' && raw.registry.trim()
    ? raw.registry.trim().replace(/\/+$/, '')
    : DEFAULT_REGISTRY
  const cacheSeconds = Number.isFinite(raw.cacheSeconds) && raw.cacheSeconds >= 0
    ? raw.cacheSeconds
    : DEFAULT_CACHE_SECONDS
  // 关掉的是「弹窗里那个按钮」和这一个 POST；查更新的徽标照常工作。
  const allowUpdate = raw.allowUpdate !== false
  return { channel, registry, cacheSeconds, allowUpdate }
}

/* ─────────────────────────── 版本比较 ─────────────────────────── */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(value) {
  const match = VERSION_RE.exec(String(value ?? '').trim())
  if (match === null) return null
  return {
    nums: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** semver 的前序比较：数字段按数值比，字母段按字典序，release 大于同号预发布。 */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const delta = Number(a) - Number(b)
      if (delta !== 0) return delta < 0 ? -1 : 1
      continue
    }
    if (aNumeric) return -1
    if (bNumeric) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** -1 / 0 / 1；任一版本号读不出来时返回 null，调用方据此走「无法比较」。 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return null
  for (let index = 0; index < 3; index += 1) {
    const delta = a.nums[index] - b.nums[index]
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  return comparePrerelease(a.pre, b.pre)
}

/* ─────────────────────────── 本机装的是哪版 ─────────────────────────── */

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function walkForPackage(anchor) {
  let dir = dirname(anchor)
  for (let hop = 0; hop < 10; hop += 1) {
    const file = join(dir, 'package.json')
    const json = readJson(file)
    if (json !== null && json.name === PACKAGE && typeof json.version === 'string') {
      return { version: json.version, file, source: 'package.json' }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 顺着启动入口往上走，找名字正好是 @deepseek-ai/dsh 的 package.json。
 *
 * 这次部署的启动命令是
 *   node E:\dsh\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js web
 * 所以 process.argv[1] 的上一级就是包根，走一步就命中。
 * 拿不到再用本模块自己的路径兜底；两条都不行时，退回宿主自己发布的 release 版本。
 */
function locateInstalledPackage(ctx) {
  const anchors = []
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') anchors.push(process.argv[1])
  try {
    anchors.push(fileURLToPath(import.meta.url))
  } catch {
    /* 不是 file: 上下文，忽略 */
  }
  for (const anchor of anchors) {
    const found = walkForPackage(anchor)
    if (found !== null) return found
  }
  // 最后一招：宿主发布的 release 身份（clientModules 给每份 boot graph 都盖上这个戳）
  try {
    const release = ctx?.get?.('clientModules')?.graph?.()?.release
    if (typeof release?.version === 'string') {
      return { version: release.version, file: null, source: 'host-release' }
    }
  } catch {
    /* 服务不在或接口变了，就当读不出来 */
  }
  return null
}

/**
 * <core>/node_modules/@deepseek-ai/dsh/package.json → <core>
 * 全局安装（不在任何 node_modules 底下）返回 null：那种装法没法用 npm install 更新。
 */
function projectRootOf(packageFile) {
  if (typeof packageFile !== 'string' || packageFile === '') return null
  let dir = dirname(packageFile)
  for (let hop = 0; hop < 8; hop += 1) {
    const parent = dirname(dir)
    if (parent === dir) return null
    if (basename(parent) === 'node_modules') return dirname(parent)
    dir = parent
  }
  return null
}

/**
 * npm 就在跑宿主的那个 node 旁边。
 *
 * 注意别直接 spawn `npm.cmd`：Node 24 起（CVE-2024-27980 之后）拒绝 spawn .cmd/.bat，
 * 同步抛 EINVAL。所以优先记 npm-cli.js，一律用 node 去跑它。
 */
function npmPaths() {
  const nodeDir = dirname(process.execPath)
  const cli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const cmd = join(nodeDir, 'npm.cmd')
  return {
    npmCli: existsSync(cli) ? cli : null,
    npmPath: existsSync(cmd) ? cmd : 'npm.cmd',
  }
}

/** 更新能力：装在 node_modules 里、核心树读得到、脚本和 npm 都在。 */
function updateCapability(settings, installed) {
  if (!settings.allowUpdate) return { canAutoUpdate: false, updateBlockedBy: 'allowUpdate' }
  if (installed?.file == null) return { canAutoUpdate: false, updateBlockedBy: 'installed unknown' }
  const coreDir = projectRootOf(installed.file)
  if (coreDir === null) return { canAutoUpdate: false, updateBlockedBy: 'not installed under node_modules' }
  if (!existsSync(join(coreDir, 'package.json'))) {
    return { canAutoUpdate: false, updateBlockedBy: `no package.json in ${coreDir}` }
  }
  if (!existsSync(UPDATE_SCRIPT)) return { canAutoUpdate: false, updateBlockedBy: `missing ${UPDATE_SCRIPT}` }
  return { canAutoUpdate: true, coreDir, ...npmPaths() }
}

/* ─────────────────────────── 插件兼容闸门 ─────────────────────────── */

/**
 * 换核心版本会连带改 DSH 的插件契约。loader 自己有一道闸
 * （dsh-app-boot 的 evaluatePluginCompatibility：engines.dsh 优先，否则看 dsh-* 的 peer），
 * 不满足就整条 bundle 层被跳过——不是警告，是那个插件的入口根本不会加载。
 *
 * 所以更新前拿同一套判定，先把当前 profile 的每个 bundle 对着**目标版本**算一遍。
 * 核心自带的 @deepseek-ai/* 跳过：它们跟核心一起换。
 */
const CORE_BUNDLE_PREFIX = '@deepseek-ai/'

/** 当前 profile 的目录和 bundle 名单；找不到返回 null（找不到就不挡人）。 */
function currentProfile(ctx) {
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home === '') return null
  const profilesDir = join(home, 'profiles')
  let names = []
  try { names = readdirSync(profilesDir) } catch { return null }
  const started = ctx?.get?.('profileContext')?.startedBundles
  let best = null
  for (const name of names) {
    const dir = join(profilesDir, name)
    const manifest = readJson(join(dir, 'package.json'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) continue
    const score = Array.isArray(started) ? started.filter((bundle) => bundles.includes(bundle)).length : 0
    if (best === null || score > best.score) best = { dir, bundles, name }
  }
  return best
}

/** dsh-app-boot 里那份判定函数；它跟宿主是同一个模块，import 一次就够了。 */
let evaluatorCache = { file: null, promise: null }
function loadEvaluator(installedFile) {
  if (evaluatorCache.file === installedFile && evaluatorCache.promise !== null) return evaluatorCache.promise
  const promise = (async () => {
    const scopeDir = dirname(dirname(installedFile))
    const entry = join(scopeDir, 'dsh-app-boot', 'lib', 'index.js')
    if (!existsSync(entry)) return null
    const module = await import(pathToFileURL(entry).href)
    return typeof module.evaluatePluginCompatibility === 'function' ? module.evaluatePluginCompatibility : null
  })().catch(() => null)
  // 读失败不缓存：包装好之前先问过一次，装好之后还得能问到。
  promise.then((evaluator) => {
    if (evaluator === null && evaluatorCache.promise === promise) evaluatorCache = { file: null, promise: null }
  })
  evaluatorCache = { file: installedFile, promise }
  return promise
}

function findBundleManifest(profileDir, name) {
  for (const file of [
    join(profileDir, 'node_modules', name, 'package.json'),
    join(dirname(profileDir), 'node_modules', name, 'package.json'),
  ]) {
    if (!existsSync(file)) continue
    const json = readJson(file)
    if (json !== null) return json
  }
  return null
}

async function loadExemptions(ctx) {
  try {
    const values = await ctx?.get?.('pluginManager')?.listVersionExemptions?.()
    return values?.exemptions ?? {}
  } catch {
    return {}
  }
}

/** 挡路的插件有没有一版能配新核心：查 registry 上的 latest，用同一套判定再看一次。 */
async function findCompatibleVersion(name, target, evaluator, exemptions, registry) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetch(`${registry}/${encodeURIComponent(name)}/latest`, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) return null
    const manifest = await response.json()
    if (typeof manifest?.version !== 'string') return null
    const issue = evaluator(manifest, exemptions, target)
    return issue === undefined || issue.exempted === true ? manifest.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 对着目标核心版本算一遍 profile 里的插件。
 *
 * 挡住分两种，差别很大：
 *   · 有新版能配新核心（upgradeTo）→ 不算挡路，跟着核心一起装就行（联合更新）
 *   · 哪一版都不行（hopeless）      → 真挡路，更新会被拒
 *
 * 返回 { ok, checked, blocked, upgrades, hopeless, profile }。
 */
async function pluginGate(ctx, target, registry) {
  const profile = currentProfile(ctx)
  if (profile === null) return { ok: true, checked: 0, blocked: [], upgrades: [], hopeless: [], note: '找不到 profile' }
  const installed = locateInstalledPackage(ctx)
  const evaluator = installed?.file == null ? null : await loadEvaluator(installed.file)
  if (evaluator === null) {
    return { ok: true, checked: 0, blocked: [], upgrades: [], hopeless: [], note: '读不到兼容性判定' }
  }

  const exemptions = await loadExemptions(ctx)
  const blocked = []
  let checked = 0
  for (const name of profile.bundles) {
    if (name.startsWith(CORE_BUNDLE_PREFIX)) continue
    const manifest = findBundleManifest(profile.dir, name)
    if (manifest === null) continue
    checked += 1
    const issue = evaluator(manifest, exemptions, target)
    if (issue === undefined || issue.exempted === true) continue
    blocked.push({ name: issue.name, version: issue.version, requirements: issue.requirements ?? {} })
  }

  for (const entry of blocked) {
    entry.upgradeTo = await findCompatibleVersion(entry.name, target, evaluator, exemptions, registry)
  }

  const upgrades = blocked
    .filter((entry) => typeof entry.upgradeTo === 'string' && entry.upgradeTo !== entry.version)
    .map((entry) => ({ name: entry.name, from: entry.version, to: entry.upgradeTo }))
  const hopeless = blocked.filter((entry) => typeof entry.upgradeTo !== 'string' || entry.upgradeTo === entry.version)

  return {
    ok: hopeless.length === 0,
    checked,
    blocked,
    upgrades,
    hopeless,
    profile: profile.name,
    profileDir: profile.dir,
  }
}

/** 挡路的插件里，哪些「升一版就能配新核心」。 */
function describePluginUpgrades(upgrades) {
  return upgrades.map((entry) => `${entry.name} ${entry.from} → ${entry.to}`).join('；')
}

/** 一句话说清「哪个插件挡路、差在哪、升级到哪一版」。 */
function describePluginBlockers(blocked) {
  return blocked.map((entry) => {
    const requirement = Object.entries(entry.requirements ?? {})
      .map(([field, range]) => `${field} ${range}`)
      .join(', ')
    const remedy = entry.upgradeTo === null || entry.upgradeTo === undefined
      ? ''
      : `，先升级到 ${entry.name}@${entry.upgradeTo}`
    return `${entry.name}@${entry.version}（要求 ${requirement}${remedy}）`
  }).join('；')
}


/* ─────────────────────────── 查更新 ─────────────────────────── */

function registryTagsUrl(registry) {
  return `${registry}/-/package/${PACKAGE.replace('/', '%2f')}/dist-tags`
}

async function fetchDistTags(registry) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS)
  timer.unref?.()
  try {
    const response = await fetch(registryTagsUrl(registry), {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`registry answered HTTP ${response.status}`)
    const json = await response.json()
    const tags = {}
    for (const name of CHANNELS) {
      if (typeof json?.[name] === 'string') tags[name] = json[name]
    }
    if (Object.keys(tags).length === 0) throw new Error('registry returned no usable dist-tags')
    return tags
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`连 ${registry} 超时（${REQUEST_TIMEOUT_MS}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 给人和模型看的那段话；工具结果和徽标 title 都用它。 */
function describe(result) {
  const installed = typeof result?.installed === 'string' ? result.installed : null
  if (result?.ok !== true) {
    const lines = [`查更新失败：${result?.error ?? '未知原因'}`]
    if (installed !== null) lines.unshift(`当前安装：@deepseek-ai/dsh ${installed}`)
    return lines.join('\n')
  }
  const lines = [`当前安装：@deepseek-ai/dsh ${installed}`]
  if (typeof result.installedFile === 'string') lines.push(`包位置：${result.installedFile}`)
  lines.push(`npm 上的 ${result.channel}：${result.latest ?? '（没有这个标签）'}`)
  if (result.updateAvailable === true) {
    lines.push(`有新版本：${installed} → ${result.latest}`)
    if (result.canAutoUpdate === true) {
      lines.push('用户可以在更新徽标的弹窗里点「现在更新」，DSH 会自动装好并重启。')
    } else {
      lines.push(`自动更新不可用（${result.updateBlockedBy ?? '原因未知'}），只能手工改核心树 package.json 再重装依赖。`)
    }
  } else if (result.ahead === true) {
    lines.push('本机这一版比 npm 上的还新（大概是本地构建或预发布）。')
  } else {
    lines.push('已经是最新的。')
  }
  const others = Object.entries(result.channels ?? {}).filter(([name]) => name !== result.channel)
  if (others.length > 0) {
    lines.push(`其它标签：${others.map(([name, version]) => `${name} ${version}`).join('，')}`)
  }
  if (result.cached === true) lines.push('（缓存结果，带 refresh 可以强查）')
  return lines.join('\n')
}

/** 自检结果的那段话。 */
function describeDoctor(value) {
  const lines = []
  lines.push(value.canAutoUpdate === true
    ? '自动更新：条件齐了'
    : `自动更新：不可用（${value.updateBlockedBy ?? '原因未知'}）`)
  if (typeof value.coreDir === 'string') lines.push(`核心树：${value.coreDir}`)
  lines.push(value.powershellOk === true
    ? (value.powershellVia === 'cmd' ? 'powershell：能拉起来（经 cmd 中转）' : 'powershell：能从宿主拉起来')
    : `powershell：拉不起来（${value.powershellError ?? '原因未知'}）`)
  lines.push(value.npmOk === true
    ? `npm：${value.npmVersion ?? '能跑'}`
    : `npm：跑不起来（${value.npmError ?? '原因未知'}）`)
  if (value.pluginsOk === false) {
    lines.push(`插件兼容：${value.pluginsBlocked ?? '有插件不认这个版本'}`)
  } else if (value.pluginsOk === true) {
    lines.push(value.pluginsUpgrades === null || value.pluginsUpgrades === undefined
      ? `插件兼容：${value.pluginsChecked} 个 bundle 都认目标版本`
      : `插件兼容：会顺带升级 ${value.pluginsUpgrades}`)
  }
  if (value.canAutoUpdate === true) {
    if (value.launchMode !== null || value.launchError !== null) {
      lines.push(value.launchOk === true
        ? `脱离宿主启动：${value.launchMode ?? '可以'}`
        : `脱离宿主启动：失败（${firstLine(value.launchError) ?? '原因未知'}）`)
    }
    lines.push(value.scriptOk === true
      ? '更新脚本：powershell 能跑起来（-DryRun 过了）'
      : `更新脚本：跑不起来（${firstLine(value.scriptError) ?? '原因未知'}）`)
  }
  if (typeof value.installed === 'string' && typeof value.latest === 'string') {
    lines.push(`版本：本机 ${value.installed}，npm ${value.latest}`)
  }
  if (value.canAutoUpdate !== true) {
    lines.push('结论：这个装法只能手工更新。')
  } else if (value.blockedBy === null || value.blockedBy === undefined) {
    lines.push('结论：点「现在更新」会走完整流程（停 DSH → 装 → 重启），装失败会回滚。')
  } else {
    lines.push('结论：先解决上面失败的那一步；现在点更新只会报错，DSH 不会被停。')
  }
  return lines.join('\n')
}

/** 自检里第一处不过的地方；全过返回 null。 */
function preflightFailure(environment) {
  const parts = []
  if (environment?.plugins !== undefined && environment.plugins?.ok !== true) {
    parts.push('插件不兼容：' + describePluginBlockers(environment.plugins.hopeless ?? environment.plugins.blocked ?? []))
  }
  if (environment?.powershell?.ok !== true) parts.push(`powershell ${environment?.powershell?.error ?? '拉不起来'}`)
  if (environment?.npm?.ok !== true) parts.push(`npm ${environment?.npm?.error ?? '跑不起来'}`)
  if (environment?.launch !== undefined && environment?.launch?.ok !== true) {
    parts.push(`脱离宿主启动 ${environment?.launch?.error ?? '失败'}`)
  }
  if (environment?.script?.ok !== true) {
    parts.push(`更新脚本 ${firstLine(environment?.script?.stderr) ?? environment?.script?.error ?? '跑不起来'}`)
  }
  return parts.length === 0 ? null : parts.join('；')
}

function firstLine(text) {
  if (typeof text !== 'string' || text === '') return null
  const line = text.split(/\r?\n/).find((part) => part.trim() !== '')
  return line === undefined ? null : line.trim().slice(0, 240)
}

/* ─────────────────────────── 更新 ─────────────────────────── */

/** 上次更新的结论：更新脚本写在核心树里的那份 result.json，重启后由这里读回来。 */
function readLastUpdate(coreDir) {
  if (typeof coreDir !== 'string') return null
  const json = readJson(join(coreDir, UPDATE_DIRNAME, 'last-update.json'))
  if (json === null || typeof json !== 'object') return null
  return {
    ok: json.ok === true,
    running: json.running === true,
    from: typeof json.from === 'string' ? json.from : null,
    to: typeof json.to === 'string' ? json.to : null,
    at: typeof json.at === 'string' ? json.at : null,
    rollback: json.rollback === true,
    error: typeof json.error === 'string' && json.error !== '' ? json.error : null,
    logFile: typeof json.logFile === 'string' ? json.logFile : null,
  }
}

/** 文件名用的时间戳，带毫秒：同一秒里点两次也不会互相盖掉对方的 plan/日志。 */
function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const ms = String(date.getMilliseconds()).padStart(3, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${ms}`
}

/** 端口只用来在脚本里判断新服务有没有起来；拿不到就传 0（跳过这一项检查）。 */
function serverPort(ctx) {
  const candidates = []
  try { candidates.push(ctx?.get?.('webApp')?.getAdvertisedUrl?.()) } catch { /* 服务不在 */ }
  try { candidates.push(ctx?.get?.('webServer')?.getOrigin?.()) } catch { /* 服务不在 */ }
  for (const url of candidates) {
    if (typeof url !== 'string') continue
    try {
      const port = Number(new URL(url).port)
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* 不是 URL，看下一个 */ }
  }
  return 0
}

/** pnpm 的 JS 入口：Node 24 拉不了 .cmd，所以找到 .cjs 用 node 跑。 */
function resolvePnpmCli(ctx) {
  const fromContext = ctx?.get?.('profileContext')?.packageManager
  const command = typeof fromContext?.command === 'string' ? fromContext.command : 'pnpm'
  const candidates = []
  if (/[\\/]/.test(command)) candidates.push(join(dirname(command), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') {
    candidates.push(join(appData, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return null
}

/**
 * 把这次更新写成一个 plan.json 交给 PowerShell。
 * 脚本不再问任何问题，也不看 npm 上有什么——版本号就是这里定下的那个。
 *
 * plugins：核心换版本会挡下谁、各自升到哪一版。脚本在装完核心、起服务之前
 * 用 profile 自己的 pnpm 把它们装上——这就是「插件市场在当前版本上装不了新插件」的解法：
 * 等核心已经换好、DSH 还没起来的时候装。
 */
function writePlan(ctx, settings, installed, target, version, plugins) {
  const coreDir = version.coreDir
  const dir = join(coreDir, UPDATE_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const at = stamp()
  const profile = currentProfile(ctx)
  const plan = {
    version: target,
    fromVersion: installed.version,
    coreDir,
    registry: settings.registry,
    npmPath: version.npmPath,
    npmCli: version.npmCli ?? null,
    serverPid: process.pid,
    nodePath: process.execPath,
    entryPath: resolve(process.argv[1] ?? ''),
    argv: process.argv.slice(2),
    workDir: process.cwd(),
    port: serverPort(ctx),
    logDir: dir,
    logFile: join(dir, `update-${at}.log`),
    resultFile: join(dir, 'last-update.json'),
    backupDir: join(dir, `backup-${at}`),
    stopTimeoutSeconds: STOP_TIMEOUT_SECONDS,
    timeoutSeconds: INSTALL_TIMEOUT_SECONDS,
    profileDir: profile?.dir ?? null,
    plugins: plugins ?? [],
    pnpmCli: resolvePnpmCli(ctx),
  }
  const planFile = join(dir, `plan-${at}.json`)
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return { plan, planFile }
}

/**
 * 拉 PowerShell。先直接拉；宿主直接被拦（杀软 / 受限制令牌只挡 node→powershell）时，
 * 再经 cmd.exe 中转一次——这条在有些机器上是唯一能走通的路。
 */
function quoteArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg
}

/** 探一下「能不能跑」，把输出收回来；direct 不行时经 cmd 中转。 */
async function runPowerShellProbe(args, timeoutMs) {
  const direct = await runProbe('powershell.exe', args, timeoutMs)
  if (direct.ok === true) return { ...direct, via: 'powershell' }
  if (typeof direct.error === 'string' && direct.error.startsWith('超时')) {
    // 已经跑起来了、只是慢：不再经 cmd 重跑一遍
    return { ...direct, via: 'none' }
  }
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  const viaCmd = await runProbe(comspec, ['/d', '/s', '/c', `powershell.exe ${args.map(quoteArg).join(' ')}`], timeoutMs)
  if (viaCmd.ok === true) return { ...viaCmd, via: 'cmd' }
  return { ok: false, error: `${direct.error ?? '拉不起来'}（经 cmd 也不行：${viaCmd.error ?? '未知'}）`, via: 'none' }
}

/** 经启动器起一个只写标记文件的子进程：标记出现，说明这条路真的能执行命令。 */
async function probeLaunch(logDir) {
  const marker = join(logDir, `launch-probe-${stamp()}.txt`)
  const inner = `"${powershellExe()}" -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '${marker}' -Value ok -Encoding ASCII"`
  const launched = await launchDetached(inner, logDir)
  if (launched.ok !== true) return { ok: false, mode: null, error: launched.error }

  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (existsSync(marker)) {
      try { rmSync(marker, { force: true }) } catch { /* 删不掉就留着 */ }
      return { ok: true, mode: 'breakaway', error: null }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120))
  }
  try { rmSync(marker, { force: true }) } catch { /* 删不掉就留着 */ }
  const died = /exited=True:exit=(-?\d+)/.exec(launched.text ?? '')
  const tail = died === null ? '' : `，它 exit 0x${(Number(died[1]) >>> 0).toString(16)}`
  return { ok: false, mode: null, error: `启动了进程（PID ${launched.pid}${tail}），但它没执行命令（标记文件没出现）` }
}

/** powershell.exe 的绝对路径（启动器要按全路径起它）。 */
function powershellExe() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(exe) ? exe : 'powershell.exe'
}

/** 更新脚本自己的命令行（交给启动器的 ArgLine）。 */
function updaterCommandLine(planFile) {
  return [
    `"${powershellExe()}"`, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', `"${UPDATE_SCRIPT}"`,
    '-Plan', `"${planFile}"`,
  ].join(' ')
}

/**
 * 经 launch-detached.ps1 起一个「离开宿主 job」的进程。
 *
 * 宿主进程在一个 Windows job 里（KILL_ON_JOB_CLOSE）。普通 spawn 出来的孩子也在里面，
 * 宿主一退出，孩子跟着被杀——这就是 23:34 那次「脚本停在等宿主退出」的原因。
 * libuv 传不了 CREATE_BREAKAWAY_FROM_JOB，所以让一个短命 powershell 去调 CreateProcessW。
 *
 * 启动器自己是普通 spawn（这条路一直正常），它退出前把 PID / 错误码打到 stdout。
 */
async function launchDetached(argLine, workDir) {
  const run = await runProbe(powershellExe(), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', LAUNCH_SCRIPT,
    '-Exe', powershellExe(),
    '-ArgLine', argLine,
    '-WorkDir', workDir,
  ], 30_000)

  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  const started = /PID:(\d+)/.exec(text)
  if (run.ok === true && started !== null) {
    return { ok: true, pid: Number(started[1]), error: null, text }
  }
  const refused = /FAIL:(\d+)/.exec(text)
  if (refused !== null) {
    const code = Number(refused[1])
    const hint = code === 5
      ? 'job 不允许 breakaway（CreateProcessW 拒绝，Win32 5）'
      : `CreateProcessW 拒绝（Win32 ${code}）`
    return { ok: false, pid: null, error: hint, text }
  }
  return { ok: false, pid: null, error: run.error ?? '启动器没有返回 PID', text }
}

/**
 * 默认执行器：经启动器起更新脚本，让它落在宿主的 job 之外。
 * 宿主退出后它还活着，才能把 npm install → 重启做完。
 */
async function defaultSpawnUpdate({ planFile }) {
  const launched = await launchDetached(updaterCommandLine(planFile), process.cwd())
  return { pid: launched.pid, child: undefined, error: launched.error }
}

/**
 * bootstrap.log 里，这只 plan 那行之后有没有「已经脱离控制台」的记录。
 * 日志是累积的：只认这只 plan 之后的那几行，旧运行的记录不能替新这次作证。
 */
export function detachedInBootstrap(text, needle) {
  if (typeof text !== 'string' || typeof needle !== 'string' || needle === '') return false
  const at = text.lastIndexOf(needle)
  if (at < 0) return false
  return /detach (freeconsole=True|noconsol=True)/.test(text.slice(at))
}

function readBootstrap(prepared) {
  try {
    return readFileSync(join(prepared.plan.logDir, 'bootstrap.log'), 'utf8')
  } catch {
    return ''
  }
}

/**
 * 两关都过了才放宿主退场：
 *   1. bootstrap.log 里出现这只 plan —— 脚本真的开始跑了
 *   2. 同一份日志里出现 detach freeconsole=True —— 它已经从宿主控制台脱开，
 *      宿主退出时不会被一起带走
 * 只看 pid、只看进程存活都不够（这台机器上就出现过「起来、exit 0、什么都没干」）。
 */
async function defaultVerifyStarted(prepared, spawned, timeoutMs = 8000) {
  let exited = null
  if (spawned?.child !== undefined) {
    spawned.child.once('exit', (code) => { exited = code ?? -1 })
  }
  const needle = basename(prepared.planFile)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = readBootstrap(prepared)
    if (text.includes(needle)) {
      if (detachedInBootstrap(text, needle)) return { ok: true, error: null }
      const tail = text.slice(text.lastIndexOf(needle))
      if (/detach FAILED|detach: aborting/.test(tail)) {
        return { ok: false, error: '脚本没能脱离控制台（FreeConsole 失败）' }
      }
    }
    if (exited !== null && !text.includes(needle)) {
      return { ok: false, error: `启动进程直接退出了（exit ${exited}），脚本没有执行` }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 120))
  }
  return {
    ok: false,
    error: exited !== null
      ? `脚本退出（exit ${exited}）前没有确认脱离控制台`
      : `脚本没有起来（${timeoutMs}ms 内 bootstrap.log 里没有 ${needle} 的 detach 记录）`,
  }
}

/* ─────────────────────────── 环境自检 ─────────────────────────── */

/**
 * 跑一个短命进程，等它退出。宿主是用自己的权限拉子进程的，
 * 这件事在这台机器上不一定行得通（受限制令牌、杀软、PATH 都可能挡），
 * 所以「点更新」之前先问一次，别等 DSH 停了才发现没人干活。
 */
function runProbe(command, args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env } })
    } catch (error) {
      finish({ ok: false, error: error?.code ?? error?.message ?? String(error) })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { if (stdout.length < 4000) stdout += chunk })
    child.stderr?.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk })
    child.on('error', (error) => finish({ ok: false, error: error?.code ?? error?.message ?? String(error) }))
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经走了 */ }
      finish({ ok: false, error: `超时（${timeoutMs}ms）` })
    }, timeoutMs)
    timer.unref?.()
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      finish({ ok: true, code, signal, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

/**
 * 真自检，三件事，任何一件不过都不许停 DSH：
 *   1. powershell 能不能从宿主拉起来（让它 exit 7）
 *   2. npm 能不能跑起来（--version）
 *   3. 更新脚本本身能不能被 powershell 跑起来（-DryRun，什么都不动）
 *
 * 第三件是关键：执行策略、杀软、编码这些毛病只会在「真去跑那个 .ps1」的时候露出来，
 * 而且 PowerShell 的报错就在 stderr 里，能直接抄进弹窗。
 */
async function defaultPreflight(ctx, capability, prepared, settings, knownGate) {
  // 插件兼容：拿核心的 loader 自己那套判定，对着「要装的那个版本」算
  const plugins = knownGate ?? await pluginGate(ctx, prepared.plan.version, settings.registry)

  const shell = await runPowerShellProbe(['-NoProfile', '-NonInteractive', '-Command', 'exit 7'], 20_000)
  const powershell = {
    ok: shell.ok === true && shell.code === 7,
    code: shell.ok === true ? shell.code : null,
    via: shell.via ?? 'none',
    error: shell.ok === true ? (shell.code === 7 ? null : `退出码 ${shell.code}`) : shell.error,
    stderr: shell.ok === true ? shell.stderr : null,
  }

  const npmRun = capability.npmCli === null
    // 没有 npm-cli.js 的老装法只能直接拉 npm.cmd，而 Node 24 对 .cmd 会抛 EINVAL
    ? await runProbe(capability.npmPath, ['--version'])
    : await runProbe(process.execPath, [capability.npmCli, '--version'])
  const npm = {
    ok: npmRun.ok === true && npmRun.code === 0,
    code: npmRun.ok === true ? npmRun.code : null,
    via: capability.npmCli === null ? String(capability.npmPath ?? 'npm.cmd') : `${basename(process.execPath)} + npm-cli.js`,
    version: npmRun.ok === true ? (npmRun.stdout.split('\n')[0] ?? '').trim() || null : null,
    error: npmRun.ok === true ? (npmRun.code === 0 ? null : `退出码 ${npmRun.code}`) : npmRun.error,
    stderr: npmRun.ok === true ? npmRun.stderr : null,
  }

  // 「能不能脱离宿主」不用另开一次探测：dry run 跑的就是同一个脚本，
  // 它开头的 FreeConsole 记录就在 dry-run.log 里，读完再删。
  let launch = { ok: true, mode: null, error: null }

  // powershell 都拉不起来就不用再试脚本了，省一次超时。
  if (powershell.ok !== true) {
    return { plugins, powershell, npm, launch, script: { ok: false, code: null, error: 'powershell 没起来，没跑脚本', stderr: null } }
  }

  const logDir = prepared.plan.logDir
  // dry plan 每次换个文件名：bootstrap.log 是累积的，重名会让人分不清哪次是哪次
  const dryName = `dry-run-plan-${stamp()}.json`
  const dryPlanFile = join(logDir, dryName)
  const dryLog = join(logDir, 'dry-run.log')
  const bootstrapFile = join(logDir, 'bootstrap.log')
  let script
  try {
    writeFileSync(dryPlanFile, `${JSON.stringify({
      ...prepared.plan,
      logFile: dryLog,
      backupDir: join(logDir, 'dry-run-backup'),
    }, null, 2)}\n`, 'utf8')
    const dry = await runPowerShellProbe([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', UPDATE_SCRIPT,
      '-Plan', dryPlanFile,
      '-DryRun',
    ], 60_000)
    script = {
      ok: dry.ok === true && dry.code === 0,
      code: dry.ok === true ? dry.code : null,
      via: dry.via ?? 'none',
      error: dry.ok === true ? (dry.code === 0 ? null : `退出码 ${dry.code}`) : dry.error,
      stderr: dry.ok === true ? dry.stderr : null,
    }
  } catch (error) {
    script = { ok: false, code: null, error: error?.message ?? String(error), stderr: null }
  } finally {
    for (const file of [dryPlanFile, dryLog]) {
      try { rmSync(file, { force: true }) } catch { /* 删不掉就留着，不影响判断 */ }
    }
  }

  // 真正要验的是「交付机制」：经启动器起的进程能不能落在宿主 job 之外、并且真的执行命令。
  // 用一个标记文件测——子进程把文件写出来才算这条路过关。
  launch = await probeLaunch(logDir)

  return { plugins, powershell, npm, launch, script }
}


/** 默认退场：先把会话日志刷盘，再结束进程——脚本在等的就是这个。 */
async function defaultShutdown(ctx) {
  try {
    const sessions = ctx?.get?.('sessions')
    for (const session of sessions?.list?.() ?? []) {
      try { await sessions.flush?.(session) } catch { /* 单条刷不动就算了 */ }
    }
  } catch { /* 服务不在，直接退 */ }
  process.exit(0)
}

/* ─────────────────────────── 插件入口 ─────────────────────────── */

export function apply(root, config = {}) {
  const settings = normalizeConfig(config)
  const spawnUpdate = typeof config.spawnUpdate === 'function' ? config.spawnUpdate : defaultSpawnUpdate
  const shutdown = typeof config.shutdown === 'function' ? config.shutdown : defaultShutdown
  const verifyStarted = typeof config.verifyStarted === 'function' ? config.verifyStarted : defaultVerifyStarted
  const shutdownDelayMs = Number.isFinite(config.shutdownDelayMs) ? config.shutdownDelayMs : SHUTDOWN_DELAY_MS
  const preflight = typeof config.preflight === 'function' ? config.preflight : defaultPreflight

  const cache = { at: 0, value: null }
  let pending = null
  const update = { phase: 'idle', target: null, from: null, startedAt: null, logFile: null, planFile: null, error: null }

  async function checkUpdate(options = {}) {
    const force = options.force === true
    const ctx = options.ctx
    if (!force && cache.value !== null && Date.now() - cache.at < settings.cacheSeconds * 1000) {
      return { ...cache.value, cached: true }
    }
    // 同时只发一次网络请求：好几个会话各挂一个徽标时，不要连发打 npm。
    if (pending !== null) return await pending

    const run = (async () => {
      const installed = locateInstalledPackage(ctx)
      const capability = updateCapability(settings, installed)
      const base = {
        installed: installed?.version ?? null,
        installedFile: installed?.file ?? null,
        installedSource: installed?.source ?? null,
        channel: settings.channel,
        registry: settings.registry,
        canAutoUpdate: capability.canAutoUpdate === true,
        updateBlockedBy: capability.updateBlockedBy ?? null,
        checkedAt: new Date().toISOString(),
      }
      try {
        if (installed === null) {
          throw new Error('读不出本机 @deepseek-ai/dsh 的版本（顺着启动入口没找到 package.json）')
        }
        const channels = await fetchDistTags(settings.registry)
        const latest = channels[settings.channel] ?? null
        if (latest === null) throw new Error(`registry 上没有 ${settings.channel} 这个标签`)
        const order = compareVersions(latest, installed.version)
        if (order === null) throw new Error(`版本号没法比：${latest} vs ${installed.version}`)
        const result = {
          ok: true,
          ...base,
          channels,
          latest,
          updateAvailable: order === 1,
          ahead: order === -1,
          cached: false,
        }
        cache.at = Date.now()
        cache.value = result
        return result
      } catch (error) {
        return { ok: false, ...base, error: error?.message ?? String(error), cached: false }
      } finally {
        pending = null
      }
    })()

    pending = run
    return await run
  }

  /** 这次没成：把刚写下的 plan 收走，别在核心树里留一堆没人用的计划。 */
  function dropPlan(prepared) {
    try {
      if (typeof prepared?.planFile === 'string') rmSync(prepared.planFile, { force: true })
    } catch { /* 删不掉就留着，反正只是一个 JSON */ }
  }

  /** 把「要不要装、装哪一版」再核一遍：POST 不能凭客户端说一句就开始装包。 */
  async function requestUpdate(ctx) {
    if (!settings.allowUpdate) return { status: 403, body: { ok: false, error: '这个 profile 关掉了自动更新' } }
    if (update.phase !== 'idle') return { status: 409, body: { ok: false, error: '已经有一次更新在进行了' } }

    const result = await checkUpdate({ force: true, ctx })
    if (result.ok !== true) return { status: 502, body: { ok: false, error: result.error ?? '查更新失败' } }
    if (result.updateAvailable !== true || typeof result.latest !== 'string') {
      return { status: 409, body: { ok: false, error: `没有可更新版本：本机 ${result.installed}，npm ${result.channel} ${result.latest ?? '未知'}` } }
    }

    const installed = locateInstalledPackage(ctx)
    const capability = updateCapability(settings, installed)
    if (capability.canAutoUpdate !== true) {
      return { status: 409, body: { ok: false, error: `自动更新不可用：${capability.updateBlockedBy ?? '原因未知'}` } }
    }

    // 先确认这台机器的宿主真拉得起 powershell 和 npm、脚本也真跑得起来。
    // 任何一步不过都别把 DSH 停掉——停下去就没人拉它回来了。
    // 插件闸门先算：挡路的要是都能升一版配新核心，就一起装（联合更新）；
    // 哪一版都不行才真拒。这一步在写 plan 之前，因为 plan 里要带上要装的插件。
    let gate
    try {
      gate = await pluginGate(ctx, result.latest, settings.registry)
    } catch (error) {
      update.phase = 'idle'
      return { status: 503, body: { ok: false, error: `插件兼容检查失败：${error?.message ?? String(error)}` } }
    }
    if (gate.ok !== true) {
      update.phase = 'idle'
      return {
        status: 409,
        body: {
          ok: false,
          error: `插件不兼容，而且没有可用的新版本：${describePluginBlockers(gate.hopeless)}`,
          ...gate,
        },
      }
    }

    let prepared
    try {
      prepared = writePlan(ctx, settings, installed, result.latest, capability, gate.upgrades)
    } catch (error) {
      update.phase = 'idle'
      return { status: 500, body: { ok: false, error: `写更新计划失败：${error?.message ?? String(error)}` } }
    }

    let environment
    try {
      environment = await preflight(ctx, capability, prepared, settings, gate)
    } catch (error) {
      update.phase = 'idle'
      dropPlan(prepared)
      return { status: 503, body: { ok: false, error: `自检本身挂了：${error?.message ?? String(error)}` } }
    }

    const blocked = preflightFailure(environment)
    if (blocked !== null) {
      update.phase = 'idle'
      dropPlan(prepared)
      return { status: 503, body: { ok: false, error: `这台机器上更新跑不起来：${blocked}`, ...environment } }
    }

    try {
      // 起脚本 + 两关确认（脚本落地、已经脱离控制台）。任何一关不过都不停 DSH。
      const spawned = (await spawnUpdate(prepared)) ?? {}
      if (spawned.pid == null) {
        update.phase = 'idle'
        dropPlan(prepared)
        return { status: 500, body: { ok: false, error: `更新脚本没起来（${spawned.error ?? 'powershell 拉不起来'}），DSH 没有动` } }
      }
      const started = await verifyStarted(prepared, spawned)
      if (started?.ok !== true) {
        update.phase = 'idle'
        dropPlan(prepared)
        try { spawned.child?.kill() } catch { /* 已经走了 */ }
        return { status: 500, body: { ok: false, error: `更新脚本没跑起来：${started?.error ?? '未知原因'}，DSH 没有动` } }
      }

      update.phase = 'scheduled'
      update.target = result.latest
      update.from = installed.version
      update.startedAt = new Date().toISOString()
      update.logFile = prepared.plan.logFile
      update.planFile = prepared.planFile

      // 宿主一退就没人管了：脚本要是先死，宁可这次不更新，也别让机器停在「服务没了」。
      if (spawned.child !== undefined) {
        spawned.child.once('exit', (code, signal) => {
          if (update.phase !== 'scheduled') return
          update.phase = 'failed'
          update.error = `更新脚本提前退出了（exit ${code ?? signal ?? '?'}），DSH 没有重启`
        })
      }

      return {
        status: 200,
        body: {
          ok: true,
          phase: update.phase,
          target: update.target,
          from: update.from,
          plugins: gate.upgrades,
          shutdownInMs: shutdownDelayMs,
          logFile: update.logFile,
          planFile: update.planFile,
          pid: spawned.pid ?? null,
        },
      }
    } catch (error) {
      update.phase = 'idle'
      return { status: 500, body: { ok: false, error: `写更新计划失败：${error?.message ?? String(error)}` } }
    }
  }

  /** 到点退场；这中间脚本要是已经死了，就取消掉这次退场。 */
  function scheduleShutdown(ctx) {
    setTimeout(() => {
      if (update.phase !== 'scheduled') return
      Promise.resolve(shutdown(ctx)).catch(() => process.exit(0))
    }, shutdownDelayMs)
  }

  /* 1. 输入框下面那个徽标要的数据 */
  root.inject(['webServer'], (ctx) => {
    const server = ctx.webServer ?? ctx.get?.('webServer')
    if (server === undefined || typeof server.register !== 'function') return

    /** 所有路由共用的连接检查 + 方法检查。 */
    const gate = (req, res, method) => {
      const connection = ctx.get?.('connection')
      if (typeof connection?.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return false
        }
      }
      if (method !== undefined && req.method !== method) {
        sendJson(res, 405, { ok: false, error: `只有 ${method}，收到 ${req.method}` })
        return false
      }
      return true
    }

    const statusHandler = async (req, res) => {
      if (!gate(req, res, 'GET')) return
      let force = false
      try {
        force = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('refresh') === '1'
      } catch {
        /* 路径读不出来就按不强制处理 */
      }
      const result = await checkUpdate({ force, ctx })
      const installed = locateInstalledPackage(ctx)
      const coreDir = projectRootOf(installed?.file ?? null)
      sendJson(res, 200, {
        ...result,
        lastUpdate: readLastUpdate(coreDir),
        summary: describe(result),
      })
    }

    const updateStatusHandler = (req, res) => {
      if (!gate(req, res, 'GET')) return
      sendJson(res, 200, {
        ok: true,
        phase: update.phase,
        target: update.target,
        from: update.from,
        startedAt: update.startedAt,
        logFile: update.logFile,
        error: update.error,
      })
    }

    const updateStartHandler = async (req, res) => {
      if (!gate(req, res, 'POST')) return
      try { req.resume?.() } catch { /* 请求体用不上，但得让它流走，不然连接会卡住 */ }
      if (req.headers?.['x-dsh-updater-action'] !== 'update') {
        sendJson(res, 400, { ok: false, error: '缺少 x-dsh-updater-action: update 请求头' })
        return
      }
      // 跨站请求带不了这个头（会先发预检，这个服务不回应），再核一次 Origin 兜底。
      const origin = req.headers?.origin
      if (typeof origin === 'string' && origin !== '') {
        const expected = originOf(ctx)
        if (expected !== null && origin.replace(/\/+$/, '') !== expected) {
          sendJson(res, 403, { ok: false, error: `origin 不匹配：${origin}` })
          return
        }
      }

      const outcome = await requestUpdate(ctx)
      sendJson(res, outcome.status, outcome.body)
      if (outcome.status === 200) scheduleShutdown(ctx)
    }

    ctx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-updater/status',
      handler: (req, res) => {
        Promise.resolve(statusHandler(req, res)).catch((error) => {
          sendJsonSafely(res, 500, { ok: false, error: error?.message ?? String(error) })
        })
      },
    }), 'dsh-updater: GET /dsh-updater/status')

    ctx.effect(() => server.register({
      kind: 'exact',
      path: '/dsh-updater/update',
      handler: (req, res) => {
        const run = req.method === 'POST' ? updateStartHandler : updateStatusHandler
        Promise.resolve(run(req, res)).catch((error) => {
          sendJsonSafely(res, 500, { ok: false, error: error?.message ?? String(error) })
        })
      },
    }), 'dsh-updater: /dsh-updater/update')
  })

  /* 2. 模型自己也能问一句 */
  root.inject(['tools'], (ctx) => {
    if (typeof ctx.tools?.register !== 'function') return
    ctx.tools.register({
      name: 'dsh_check_update',
      description: `查这台机器上装的 @deepseek-ai/dsh 是哪一版，再去 npm 看有没有更新的发布。

只读：读启动入口旁边的 package.json，再 GET 一次 registry 的 dist-tags。
结果在宿主侧缓存 10 分钟，refresh:true 强制重查。
升级不走这个工具：更新徽标里的弹窗问过用户以后会自己装包并重启 DSH。`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          refresh: {
            type: 'boolean',
            description: '跳过 10 分钟缓存，现在就连 npm 查一次。默认 false。',
          },
        },
      },
      output: {
        // 宿主只支持 JSON Schema 的一个子集：type 必须是单个字符串（不能写 ["string","null"]），
        // additionalProperties 必须是布尔量，可空字段用 oneOf。写宽了 tools.register() 会直接抛错。
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            installed: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            installedFile: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            installedSource: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            latest: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            channel: { type: 'string' },
            updateAvailable: { type: 'boolean' },
            ahead: { type: 'boolean' },
            cached: { type: 'boolean' },
            canAutoUpdate: { type: 'boolean' },
            updateBlockedBy: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            checkedAt: { type: 'string' },
            error: { type: 'string' },
            summary: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? describe(value)) }],
      },
      execute: async (args) => {
        const result = await checkUpdate({ force: args?.refresh === true, ctx })
        return { ...result, summary: describe(result) }
      },
    })

    ctx.tools.register({
      name: 'dsh_update_doctor',
      description: `查这台机器上的自动更新到底卡在哪：核心树读不读得到、npm 和 powershell 能不能从宿主拉起来。
慢一步（要真跑两个短命进程），但不会停 DSH、不装包、不写核心树。`,
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            canAutoUpdate: { type: 'boolean' },
            updateBlockedBy: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            installed: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            latest: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            coreDir: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            npmPath: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            powershellOk: { type: 'boolean' },
            powershellVia: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            powershellError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            npmOk: { type: 'boolean' },
            npmError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            npmVersion: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            npmVia: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            pluginsOk: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
            pluginsChecked: { type: 'number' },
            pluginsBlocked: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            pluginsUpgrades: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            launchOk: { type: 'boolean' },
            launchMode: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            launchError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            scriptOk: { type: 'boolean' },
            scriptError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            blockedBy: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            summary: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
      },
      execute: async () => {
        const installed = locateInstalledPackage(ctx)
        const capability = updateCapability(settings, installed)
        const check = await checkUpdate({ force: true, ctx })

        // 自检用的是「更新时会用的那份 plan」，但只跑 -DryRun，什么都不动。
        let environment = null
        if (capability.canAutoUpdate === true) {
          const planDir = join(capability.coreDir, UPDATE_DIRNAME)
          mkdirSync(planDir, { recursive: true })
          const synthetic = {
            planFile: null,
            plan: {
              version: '0.0.0-doctor',
              fromVersion: installed?.version ?? null,
              coreDir: capability.coreDir,
              registry: settings.registry,
              npmPath: capability.npmPath,
              npmCli: capability.npmCli,
              serverPid: process.pid,
              nodePath: process.execPath,
              entryPath: resolve(process.argv[1] ?? ''),
              argv: process.argv.slice(2),
              workDir: process.cwd(),
              port: serverPort(ctx),
              logDir: planDir,
              logFile: join(planDir, 'doctor-dry.log'),
              resultFile: join(planDir, 'last-update.json'),
              backupDir: join(planDir, 'dry-run-backup'),
              stopTimeoutSeconds: STOP_TIMEOUT_SECONDS,
              timeoutSeconds: INSTALL_TIMEOUT_SECONDS,
            },
          }
          // 自检的「目标版本」= npm 上那个 latest，跟真更新时会用的版本一致
          if (typeof check?.latest === 'string') synthetic.plan.version = check.latest
          environment = await preflight(ctx, capability, synthetic, settings)
        }

        const value = {
          ok: true,
          canAutoUpdate: capability.canAutoUpdate === true,
          updateBlockedBy: capability.updateBlockedBy ?? null,
          installed: installed?.version ?? null,
          latest: check.latest ?? null,
          coreDir: capability.coreDir ?? null,
          npmPath: capability.npmPath ?? null,
          powershellOk: environment?.powershell?.ok === true,
          powershellVia: environment?.powershell?.via ?? null,
          powershellError: environment?.powershell?.error ?? null,
          npmOk: environment?.npm?.ok === true,
          npmError: environment?.npm?.error ?? null,
          npmVersion: environment?.npm?.version ?? null,
          npmVia: environment?.npm?.via ?? null,
          pluginsOk: environment?.plugins === undefined ? null : environment.plugins.ok === true,
          pluginsChecked: environment?.plugins?.checked ?? 0,
          pluginsBlocked: (environment?.plugins?.hopeless?.length ?? 0) > 0 ? describePluginBlockers(environment.plugins.hopeless) : null,
          pluginsUpgrades: (environment?.plugins?.upgrades?.length ?? 0) > 0 ? describePluginUpgrades(environment.plugins.upgrades) : null,
          launchOk: environment?.launch?.ok === true,
          launchMode: environment?.launch?.mode ?? null,
          launchError: environment?.launch?.error ?? null,
          scriptOk: environment?.script?.ok === true,
          scriptError: environment?.script?.stderr !== null && environment?.script?.stderr !== undefined && environment.script.stderr !== ''
            ? environment.script.stderr
            : (environment?.script?.error ?? null),
          blockedBy: preflightFailure(environment),
        }
        return { ...value, summary: describeDoctor(value) }
      },
    })
  })
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

function originOf(ctx) {
  try {
    const origin = ctx?.get?.('webApp')?.getAdvertisedUrl?.() ?? ctx?.get?.('webServer')?.getOrigin?.()
    if (typeof origin !== 'string' || origin === '') return null
    return new URL(origin).origin
  } catch {
    return null
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function sendJsonSafely(res, status, value) {
  try {
    sendJson(res, status, value)
  } catch {
    /* 响应已经走了 */
  }
}
