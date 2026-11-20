/**
 * 浏览器半侧的离线检查：不需要真浏览器，也不装 react。
 *
 * 用最小 React 垫片（useState/useEffect/useRef/useCallback + 一次手动 flush）
 * 跑一遍 client.js 的注册路径和渲染路径：
 *   · factory 注册的 id、require 表、slots 依赖
 *   · apply 往 conversation.composer.dock / shell.overlay 塞的 id/order
 *   · 徽标：检查中 → 可更新 → 展开明细面板 → 面板里重新检查变已是最新 → 断网变失败
 *   · 弹窗：查到新版本自己弹出来 → 现在更新 → 页面断开 → 稍后不再提醒
 * 真浏览器里 React 是真的，这里只保证结构、状态流转和文案没说错。
 */
import { readFileSync } from 'node:fs'

/* ─────────────────────────── 最小 React 垫片 ─────────────────────────── */

const FRAGMENT = Symbol('Fragment')
const hooks = []
const effectDeps = []
const cleanups = []
let hookIndex = 0
let pendingEffects = []

const React = {
  Fragment: FRAGMENT,
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useState(initial) {
    const at = hookIndex++
    if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      hooks[at] = typeof next === 'function' ? next(hooks[at]) : next
    }
    return [hooks[at], set]
  },
  useEffect(effect, deps) {
    const at = hookIndex++
    const previous = effectDeps[at]
    const changed = previous === undefined || deps === undefined || deps.length !== previous.length
      || deps.some((value, index) => !Object.is(value, previous[index]))
    if (!changed) return
    effectDeps[at] = deps
    pendingEffects.push({ at, effect })
  },
  useRef(value) {
    const at = hookIndex++
    if (!(at in hooks)) hooks[at] = { current: value }
    return hooks[at]
  },
  useCallback(fn) {
    hookIndex += 1
    return fn
  },
}

/* ─────────────────────────── localStorage 垫片 ─────────────────────────── */

const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
  clear: () => storage.clear(),
}

/* ─────────────────────────── 载入 client.js ─────────────────────────── */

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let registration = null
globalThis.window = {
  __ModuleLoader__: { load(reg) { registration = reg } },
  location: { href: 'http://127.0.0.1:3080/' },
}
globalThis.document = { baseURI: 'http://127.0.0.1:3080/' }

function bootClientModule() {
  let loaded = null
  const win = {
    __ModuleLoader__: { load(reg) { loaded = reg } },
    location: { href: 'http://127.0.0.1:3080/' },
  }
  new Function('window', 'document', source)(win, { baseURI: 'http://127.0.0.1:3080/' })
  return loaded
}

new Function('window', 'document', source)(globalThis.window, globalThis.document)

const checks = []
function ok(name, condition, detail) {
  checks.push({ name, pass: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

ok('注册了 factory', registration !== null && typeof registration.factory === 'function')
ok('注册 id 是包名', registration?.id === 'dsh-updater', registration?.id)

const required = []
const module = registration.factory((spec) => {
  required.push(spec)
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})
ok('只 require react', required.length === 1 && required[0] === 'react', JSON.stringify(required))
ok('声明了 slots 依赖', Array.isArray(module.inject) && module.inject.includes('slots'))

/* ─────────────────────────── apply：槽位注册 ─────────────────────────── */

const injectKeys = []
const slots = {}
module.apply({
  get: () => undefined,
  slots: {
    inject(key, callback) {
      injectKeys.push(key)
      callback()
      return () => {}
    },
    register(options, component) {
      slots[options.name] = { options, component }
      return () => {}
    },
  },
})

ok('徽标注入到 conversation.composer.dock', injectKeys.includes('conversation.composer.dock'), JSON.stringify(injectKeys))
ok('弹窗注入到 shell.overlay', injectKeys.includes('shell.overlay'), JSON.stringify(injectKeys))
ok('徽标用自己的 id', slots['conversation.composer.dock']?.options?.id === 'dsh-updater',
  JSON.stringify(slots['conversation.composer.dock']?.options))
ok('徽标排在 shipped 条目之后', slots['conversation.composer.dock']?.options?.order === 2)
ok('弹窗有自己的 id 和 order', slots['shell.overlay']?.options?.id === 'dsh-updater-update'
  && typeof slots['shell.overlay']?.options?.order === 'number',
  JSON.stringify(slots['shell.overlay']?.options))
const Component = slots['conversation.composer.dock']?.component
ok('拿到了徽标组件', typeof Component === 'function')

/* ─────────────────────────── 一次手动 render + flush ─────────────────────────── */

function collect(node, texts, nodes) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    texts.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, texts, nodes)
    return
  }
  if (typeof node.type === 'function') {
    collect(node.type(node.props ?? {}), texts, nodes)
    return
  }
  if (node.type !== FRAGMENT) nodes.push(node)
  for (const child of node.children ?? []) collect(child, texts, nodes)
}

function textOf(node) {
  const texts = []
  collect(node, texts, [])
  return texts.join('').replace(/\s+/g, ' ').trim()
}

function resetHooks() {
  hooks.length = 0
  effectDeps.length = 0
  cleanups.length = 0
  hookIndex = 0
  pendingEffects = []
}

function render(target = Component, props = {}) {
  hookIndex = 0
  pendingEffects = []
  const tree = target(props)
  const texts = []
  const nodes = []
  collect(tree, texts, nodes)
  for (const { at, effect } of pendingEffects) {
    if (typeof cleanups[at] === 'function') cleanups[at]()
    const cleanup = effect()
    cleanups[at] = typeof cleanup === 'function' ? cleanup : undefined
  }
  const buttons = nodes.filter((node) => node.type === 'button')
  return {
    text: texts.join(' ').replace(/\s+/g, ' ').trim(),
    button: buttons[0],
    buttons,
    style: nodes.find((node) => node.type === 'style'),
    panel: nodes.find((node) => node.props?.['data-dsh-updater-panel'] !== undefined),
    dialog: nodes.find((node) => node.props?.['data-dsh-updater-dialog'] !== undefined),
    nodes,
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ─────────────────────────── fetch 打桩 ─────────────────────────── */

const PKG_FILE = 'E:\\dsh\\dsh\\node_modules\\@deepseek-ai\\dsh\\package.json'

function statusPayload(overrides = {}) {
  return {
    ok: true,
    installed: '0.2.1-rc.5',
    installedFile: PKG_FILE,
    latest: '0.2.2-rc.1',
    channel: 'latest',
    channels: { latest: '0.2.2-rc.1', next: '0.2.2-rc.3', alpha: '0.2.2-alpha.3' },
    updateAvailable: true,
    ahead: false,
    cached: false,
    canAutoUpdate: true,
    updateBlockedBy: null,
    checkedAt: '2026-11-14T02:01:00.000Z',
    lastUpdate: null,
    summary: '有新版本：0.2.1-rc.5 → 0.2.2-rc.1',
    ...overrides,
  }
}

let calls = []
let respond = async () => ({ ok: true, json: async () => statusPayload() })
globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options })
  return await respond()
}

// 第一次渲染：effect 里发起 load(false)
let view = render()
ok('首次渲染不抛异常', view.button !== undefined)
ok('检查中先显示占位文案', view.text.includes('checking for updates'), JSON.stringify(view.text))
ok('style 里有主题 token', view.style?.props?.dangerouslySetInnerHTML?.__html?.includes('--dsw-alias-label-secondary'))
ok('默认不展开面板', view.panel === undefined)
ok('第一次取数打到 /dsh-updater/status', calls.length === 1 && calls[0].url === 'http://127.0.0.1:3080/dsh-updater/status', calls[0]?.url)
ok('请求带 same-origin 凭据', calls[0]?.options?.credentials === 'same-origin')

await sleep(20)
view = render()
ok('拿到结果后显示可更新', view.text.includes('0.2.2-rc.1') && view.text.includes('update available'), JSON.stringify(view.text))
ok('带上本机版本', view.text.includes('0.2.1-rc.5'), JSON.stringify(view.text))
ok('title 提示点开看结果', String(view.button?.props?.title ?? '').includes('full result'), JSON.stringify(view.button?.props?.title))

/* ─────────────────────────── 展开明细面板 ─────────────────────────── */

const beforeOpen = calls.length
view.button.props.onClick()
view = render()

ok('点徽标展开面板', view.panel !== undefined)
ok('展开不重复取数', calls.length === beforeOpen, `calls ${beforeOpen} → ${calls.length}`)
ok('徽标标了 aria-expanded', view.button.props['aria-expanded'] === true)
ok('面板里有本机版本', view.text.includes('@deepseek-ai/dsh 0.2.1-rc.5'), JSON.stringify(view.text))
ok('面板里有包路径', view.text.includes(PKG_FILE))
ok('面板里列出三个 channel',
  ['npm latest', 'npm next', 'npm alpha'].every((key) => view.text.includes(key)) && view.text.includes('0.2.2-rc.3'),
  JSON.stringify(view.text))
ok('面板里有检查时间（本地格式）', /Checked\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(view.text), JSON.stringify(view.text))
ok('面板里有操作按钮', view.buttons.map(textOf).join(',').includes('Refresh'))
ok('可更新时面板里有「现在更新」', view.buttons.map(textOf).includes('Update now'), view.buttons.map(textOf).join('|'))
ok('点徽标第二次收起', (() => {
  view.button.props.onClick()
  view = render()
  return view.panel === undefined
})())
view.button.props.onClick()
view = render()

/* ─────────────────────────── 面板里重新检查 ─────────────────────────── */

respond = async () => ({
  ok: true,
  json: async () => statusPayload({
    latest: '0.2.1-rc.5',
    channels: { latest: '0.2.1-rc.5', next: '0.2.1-rc.5', alpha: '0.2.2-alpha.3' },
    updateAvailable: false,
    checkedAt: '2026-11-14T02:05:00.000Z',
    summary: '已经是最新的。',
  }),
})
const beforeRefresh = calls.length
const refresh = view.buttons.find((node) => textOf(node) === 'Refresh')
ok('面板里找得到重新检查按钮', refresh !== undefined, view.buttons.map(textOf).join('|'))
refresh.props.onClick()
ok('重新检查立刻发请求', calls.length === beforeRefresh + 1, `calls ${beforeRefresh} → ${calls.length}`)
ok('强查带了 refresh=1', calls.at(-1).url.includes('refresh=1'), calls.at(-1).url)
await sleep(20)
view = render()
ok('已是新版本时显示 up to date', view.text.includes('up to date'), JSON.stringify(view.text))
ok('已是最新时面板里没有「现在更新」', !view.buttons.map(textOf).includes('Update now'), view.buttons.map(textOf).join('|'))

// 再点一次：断网
respond = async () => { throw new Error('Failed to fetch') }
view.buttons.find((node) => textOf(node) === 'Refresh').props.onClick()
await sleep(20)
view = render()
ok('断网时显示查更新失败', view.text.includes('update check failed'), JSON.stringify(view.text))
ok('失败时 title 带原因', String(view.button?.props?.title ?? '').includes('Failed to fetch'), JSON.stringify(view.button?.props?.title))
ok('失败时面板里有错误行', view.text.includes('Failed to fetch'), JSON.stringify(view.text))

/* ─────────────────────────── 界面语言是中文时 ─────────────────────────── */

let zhComponent = null
module.apply({
  get: (name) => (name === 'locale'
    ? { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }
    : undefined),
  slots: {
    inject: (_key, callback) => {
      callback()
      return () => {}
    },
    register: (_options, component) => {
      if (_options.name === 'conversation.composer.dock') zhComponent = component
      return () => {}
    },
  },
})
resetHooks()

let zhView = render(zhComponent)
ok('中文界面先显示检查更新中', zhView.text.includes('检查更新中'), JSON.stringify(zhView.text))
await sleep(20)
zhView = render(zhComponent)
ok('中文界面显示已是最新（复用缓存）', zhView.text.includes('已是最新'), JSON.stringify(zhView.text))
ok('中文界面也带版本号', zhView.text.includes('0.2.1-rc.5'), JSON.stringify(zhView.text))
zhView.button.props.onClick()
zhView = render(zhComponent)
ok('中文面板用中文标签', zhView.text.includes('当前安装') && zhView.text.includes('重新检查'), JSON.stringify(zhView.text))
ok('中文面板也列出 channel', zhView.text.includes('npm next'), JSON.stringify(zhView.text))

/* ─────────────────────────── 弹窗：查到新版本自己弹 ─────────────────────────── */
// 换一份模块实例：它有自己的 shared 缓存和 prompt 开关，不受上面这轮取数影响。

const dialogRegistration = bootClientModule()
const dialogModule = dialogRegistration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})

const zhCtx = {
  get: (name) => (name === 'locale'
    ? { getLocale: () => ({ active: 'zh-CN' }), subscribe: () => () => {} }
    : undefined),
}
let PromptComponent = null
dialogModule.apply({
  ...zhCtx,
  slots: {
    inject: (_key, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      if (options.name === 'shell.overlay') PromptComponent = component
      return () => {}
    },
  },
})
ok('弹窗组件拿到了', typeof PromptComponent === 'function')

storage.clear()
let dialogCalls = []
let postResponse = { ok: true, status: 200, json: async () => ({ ok: true, phase: 'scheduled', target: '0.2.2-rc.1', from: '0.2.1-rc.5', shutdownInMs: 1200 }) }
globalThis.fetch = async (url, options = {}) => {
  const call = { url: String(url), options }
  dialogCalls.push(call)
  if (options.method === 'POST') return postResponse
  if (String(url).includes('dsh-updater/update')) throw new Error('ECONNREFUSED')
  return { ok: true, json: async () => statusPayload() }
}

resetHooks()
let dialogView = render(() => PromptComponent({ ctx: zhCtx }))
ok('还没取到数据时弹窗不出现', dialogView.dialog === undefined)

await sleep(20)
dialogView = render(() => PromptComponent({ ctx: zhCtx }))
ok('查到新版本就自己弹出来', dialogView.dialog !== undefined, JSON.stringify(dialogView.text))
ok('弹窗有标题', dialogView.text.includes('DSH 有新版本了'), JSON.stringify(dialogView.text))
ok('弹窗把两个版本都摊出来',
  dialogView.text.includes('0.2.1-rc.5') && dialogView.text.includes('0.2.2-rc.1'), JSON.stringify(dialogView.text))
ok('弹窗说明了会重启', dialogView.text.includes('自动重启'), JSON.stringify(dialogView.text))
ok('弹窗有两个选择', ['稍后', '现在更新'].every((label) => dialogView.buttons.map(textOf).includes(label)),
  dialogView.buttons.map(textOf).join('|'))

/* ─────────────────────────── 选「现在更新」 ─────────────────────────── */

const now = dialogView.buttons.find((node) => textOf(node) === '现在更新')
now.props.onClick()
await sleep(20)
dialogView = render(() => PromptComponent({ ctx: zhCtx }))
const postCall = dialogCalls.find((call) => call.options?.method === 'POST')
ok('点了就 POST 一次 /dsh-updater/update', postCall !== undefined && postCall.url === 'http://127.0.0.1:3080/dsh-updater/update',
  postCall?.url)
ok('POST 带上确认头', postCall?.options?.headers?.['x-dsh-updater-action'] === 'update', JSON.stringify(postCall?.options?.headers))
ok('POST 带 same-origin 凭据', postCall?.options?.credentials === 'same-origin')
ok('宿主答应以后说「马上停下」', dialogView.text.includes('DSH 马上停下'), JSON.stringify(dialogView.text))
ok('进行中不再给按钮', dialogView.buttons.length === 0, dialogView.buttons.map(textOf).join('|'))

// 1.5s 之后进入「正在装」；再过两秒轮询失败，就是服务没了
await sleep(1600)
dialogView = render(() => PromptComponent({ ctx: zhCtx }))
ok('过了准备期显示正在装', dialogView.text.includes('正在装新版本'), JSON.stringify(dialogView.text))
await sleep(2200)
dialogView = render(() => PromptComponent({ ctx: zhCtx }))
ok('服务断开以后显示正在重启', dialogView.text.includes('DSH 正在重启'), JSON.stringify(dialogView.text))
ok('断开以后条子变成流动的（不知道到哪一步了）',
  dialogView.nodes.some((node) => node.props?.['data-dsh-updater-indeterminate'] !== undefined),
  JSON.stringify(dialogView.text))
ok('断开以后可以关掉窗口', dialogView.buttons.map(textOf).includes('关闭'), dialogView.buttons.map(textOf).join('|'))

/* ─────────────────────────── 选「稍后」 ─────────────────────────── */

const dismissRegistration = bootClientModule()
const dismissModule = dismissRegistration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})
let dismissPrompt = null
dismissModule.apply({
  ...zhCtx,
  slots: {
    inject: (_key, callback) => { callback(); return () => {} },
    register: (options, component) => {
      if (options.name === 'shell.overlay') dismissPrompt = component
      return () => {}
    },
  },
})

storage.clear()
globalThis.fetch = async (url) => {
  if (String(url).includes('dsh-updater/update')) throw new Error('ECONNREFUSED')
  return { ok: true, json: async () => statusPayload() }
}
resetHooks()
let laterView = render(() => dismissPrompt({ ctx: zhCtx }))
await sleep(20)
laterView = render(() => dismissPrompt({ ctx: zhCtx }))
const later = laterView.buttons.find((node) => textOf(node) === '稍后')
ok('弹窗里有「稍后」', later !== undefined, laterView.buttons.map(textOf).join('|'))
later.props.onClick()
laterView = render(() => dismissPrompt({ ctx: zhCtx }))
ok('选稍后就把弹窗关掉', laterView.dialog === undefined)
ok('选稍后记住这个版本', storage.get('dsh-updater:dismissed-version') === '0.2.2-rc.1', String(storage.get('dsh-updater:dismissed-version')))

/* ─────────────────────────── 宿主说「脚本没跑起来」 ─────────────────────────── */

const failRegistration = bootClientModule()
const failModule = failRegistration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})
let failPrompt = null
failModule.apply({
  ...zhCtx,
  slots: {
    inject: (_key, callback) => { callback(); return () => {} },
    register: (options, component) => {
      if (options.name === 'shell.overlay') failPrompt = component
      return () => {}
    },
  },
})

storage.clear()
globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ ok: true, phase: 'scheduled' }) }
  }
  if (String(url).includes('dsh-updater/update')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, phase: 'failed', error: 'npm 不存在' }) }
  }
  return { ok: true, json: async () => statusPayload() }
}

resetHooks()
let failView = render(() => failPrompt({ ctx: zhCtx }))
await sleep(20)
failView = render(() => failPrompt({ ctx: zhCtx }))
failView.buttons.find((node) => textOf(node) === '现在更新').props.onClick()
await sleep(20)
failView = render(() => failPrompt({ ctx: zhCtx }))
await sleep(1700)
failView = render(() => failPrompt({ ctx: zhCtx }))
await sleep(200)
failView = render(() => failPrompt({ ctx: zhCtx }))
ok('宿主说脚本没跑起来时把原因显示出来', failView.text.includes('更新没能开始：npm 不存在'), JSON.stringify(failView.text))
ok('这种情况给「知道了」', failView.buttons.map(textOf).includes('知道了'), failView.buttons.map(textOf).join('|'))

/* ─────────────────────────── 进度条：三段走完 ─────────────────────────── */
// 宿主还活着（sending，真步进） → DSH 不在（applying/offline，流动） → 新 DSH 回来（done，走到头）
// 这一段用一个新模块实例：它有自己的 shared 缓存、prompt 开关和 hooks。

const progressRegistration = bootClientModule()
const progressModule = progressRegistration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})
let progressPrompt = null
progressModule.apply({
  ...zhCtx,
  slots: {
    inject: (_key, callback) => { callback(); return () => {} },
    register: (options, component) => {
      if (options.name === 'shell.overlay') progressPrompt = component
      return () => {}
    },
  },
})

/** 宿主那五步：done 个完成，running 那一步在跑。 */
function prepSteps(doneCount, running, detail = null) {
  const ids = ['check', 'gate', 'plan', 'preflight', 'spawn']
  return {
    steps: ids.map((id, index) => ({
      id,
      status: index < doneCount ? 'done' : (id === running ? 'running' : 'pending'),
      at: null,
    })),
    percent: Math.round((doneCount / ids.length) * 100),
    detail,
  }
}

/** 脚本写下的那条记录：时间是相对现在造的，不然「是不是这一次」的时间检查会把它当旧的。 */
function finishedRecord(overrides = {}) {
  const now = Date.now()
  const iso = (offset) => new Date(now + offset).toISOString()
  return {
    ok: true,
    running: false,
    rollback: false,
    from: '0.2.1-rc.5',
    to: '0.2.2-rc.1',
    at: iso(-1000),
    startedAt: null,
    updatedAt: null,
    step: null,
    total: 4,
    percent: 100,
    // 总耗时由各步之和算出来（187000ms = 3分07秒），时间戳这里不掺和
    steps: [
      { id: 'stop', ms: 320, at: iso(-187000) },
      { id: 'backup', ms: 90, at: iso(-186000) },
      { id: 'install', ms: 182390, at: iso(-186000) },
      { id: 'start', ms: 4200, at: iso(-5000) },
    ],
    error: null,
    logFile: 'E:/dsh/dsh/.dsh-updater/update-1.log',
    ...overrides,
  }
}

storage.clear()
let updateMode = 'preparing'
let prepNow = prepSteps(0, 'check')
let postResolve = null
let progressRecord = null

globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    // POST 先挂着：宿主正在自检，界面这几秒问得到真步子
    return await new Promise((resolve) => {
      postResolve = () => resolve({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          phase: 'scheduled',
          target: '0.2.2-rc.1',
          from: '0.2.1-rc.5',
          logFile: 'E:/dsh/dsh/.dsh-updater/update-1.log',
          steps: prepSteps(5, null).steps,
          percent: 100,
        }),
      })
    })
  }
  if (String(url).includes('dsh-updater/update')) {
    if (updateMode === 'down') throw new Error('ECONNREFUSED')
    if (updateMode === 'back') {
      return { ok: true, status: 200, json: async () => ({ ok: true, phase: 'idle', steps: [], lastUpdate: progressRecord }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, phase: 'preparing', ...prepNow, lastUpdate: null }),
    }
  }
  return { ok: true, json: async () => statusPayload() }
}

resetHooks()
let pView = render(() => progressPrompt({ ctx: zhCtx }))
await sleep(20)
pView = render(() => progressPrompt({ ctx: zhCtx }))
pView.buttons.find((node) => textOf(node) === '现在更新').props.onClick()
await sleep(30)
pView = render(() => progressPrompt({ ctx: zhCtx }))
await sleep(60)
pView = render(() => progressPrompt({ ctx: zhCtx }))

function barNode(view) {
  return view.nodes.find((node) => node.props?.['data-dsh-updater-bar'] !== undefined)
}
function percentText(view) {
  const node = view.nodes.find((node) => node.props?.['data-dsh-updater-percent'] !== undefined)
  return node === undefined ? null : textOf(node)
}

ok('准备阶段就有进度条', barNode(pView) !== undefined, JSON.stringify(pView.text))
ok('准备阶段报第几步', pView.text.includes('正在准备 0/5'), JSON.stringify(pView.text))
ok('准备阶段条子有百分比', percentText(pView) === '0%', String(percentText(pView)))

prepNow = prepSteps(2, 'preflight', 'script')
await sleep(400)
pView = render(() => progressPrompt({ ctx: zhCtx }))
ok('宿主往前走一步，条子跟着涨', percentText(pView) === '40%', String(percentText(pView)))
ok('条子写明正在自检哪一项',
  pView.text.includes('检查插件兼容') === false && pView.text.includes('环境自检') && pView.text.includes('更新脚本'),
  JSON.stringify(pView.text))
ok('条子的填充宽度按百分比来', barNode(pView)?.children?.[0]?.props?.style?.width === '40%',
  JSON.stringify(barNode(pView)?.children?.[0]?.props?.style))

postResolve()
await sleep(40)
pView = render(() => progressPrompt({ ctx: zhCtx }))
ok('宿主答应以后条子满格', percentText(pView) === '100%', String(percentText(pView)))
ok('满格时说明准备完了', pView.text.includes('正在准备 5/5'), JSON.stringify(pView.text))

// 1.5s 之后宿主退场，条子只能流动着等
await sleep(1700)
pView = render(() => progressPrompt({ ctx: zhCtx }))
ok('DSH 不在的时候条子流动', barNode(pView)?.props?.['data-dsh-updater-indeterminate'] !== undefined,
  JSON.stringify(barNode(pView)?.props))
ok('流动的时候报已用时', /正在装新版本 · 已用时 \d/.test(pView.text), JSON.stringify(pView.text))

// 服务断开两次 → offline，但还在等（这次不再放弃）
updateMode = 'down'
await sleep(2600)
pView = render(() => progressPrompt({ ctx: zhCtx }))
ok('服务断开以后说 DSH 不在', pView.text.includes('DSH 不在，正在装或重启'), JSON.stringify(pView.text))
ok('断开以后还能关窗口', pView.buttons.map(textOf).includes('关闭'), pView.buttons.map(textOf).join('|'))

// 新 DSH 起来了：读回脚本写的那条记录，条子走到头
updateMode = 'back'
progressRecord = finishedRecord()
await sleep(1300)
pView = render(() => progressPrompt({ ctx: zhCtx }))
ok('新 DSH 回来以后显示更新完成', pView.text.includes('更新完成'), JSON.stringify(pView.text))
ok('完成时条子满格', percentText(pView) === '100%', String(percentText(pView)))
ok('完成时列出每步耗时', pView.text.includes('装核心 3分02秒') && pView.text.includes('停 DSH 0.3秒'), JSON.stringify(pView.text))
ok('完成时给出总耗时', pView.text.includes('已用时 3分07秒'), JSON.stringify(pView.text))
ok('完成时给「重新载入页面」', pView.buttons.map(textOf).includes('重新载入页面'), pView.buttons.map(textOf).join('|'))
ok('完成时不再给「现在更新」', !pView.buttons.map(textOf).includes('现在更新'), pView.buttons.map(textOf).join('|'))
ok('完成的条子是绿的', barNode(pView)?.props?.['data-dsh-updater-tone'] === 'success',
  String(barNode(pView)?.props?.['data-dsh-updater-tone']))

/* ─────────────────────────── 进度条：回滚那次 ─────────────────────────── */

const rollbackRegistration = bootClientModule()
const rollbackModule = rollbackRegistration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})
let rollbackPrompt = null
rollbackModule.apply({
  ...zhCtx,
  slots: {
    inject: (_key, callback) => { callback(); return () => {} },
    register: (options, component) => {
      if (options.name === 'shell.overlay') rollbackPrompt = component
      return () => {}
    },
  },
})

storage.clear()
const rolledBack = finishedRecord({
  ok: false,
  rollback: true,
  percent: 50,
  step: 'install',
  error: 'npm install failed (exit 1); rolled back to 0.2.1-rc.5',
  steps: [
    { id: 'stop', ms: 320, at: new Date().toISOString() },
    { id: 'backup', ms: 90, at: new Date().toISOString() },
  ],
  total: 4,
})
globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    return { ok: true, status: 200, json: async () => ({ ok: true, phase: 'scheduled', target: '0.2.2-rc.1', from: '0.2.1-rc.5' }) }
  }
  if (String(url).includes('dsh-updater/update')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, phase: 'idle', steps: [], lastUpdate: rolledBack }) }
  }
  return { ok: true, json: async () => statusPayload() }
}

resetHooks()
let rView = render(() => rollbackPrompt({ ctx: zhCtx }))
await sleep(20)
rView = render(() => rollbackPrompt({ ctx: zhCtx }))
rView.buttons.find((node) => textOf(node) === '现在更新').props.onClick()
await sleep(30)
rView = render(() => rollbackPrompt({ ctx: zhCtx }))
await sleep(1700)
rView = render(() => rollbackPrompt({ ctx: zhCtx }))
await sleep(1200)
rView = render(() => rollbackPrompt({ ctx: zhCtx }))
await sleep(200)
rView = render(() => rollbackPrompt({ ctx: zhCtx }))

ok('回滚以后说成回滚', rView.text.includes('这次更新回滚了'), JSON.stringify(rView.text))
ok('回滚时点名卡在哪一步', rView.text.includes('卡在 装核心'), JSON.stringify(rView.text))
ok('回滚时把原因摊出来', rView.text.includes('npm install failed'), JSON.stringify(rView.text))
ok('回滚的条子是橙的（不是绿的）', barNode(rView)?.props?.['data-dsh-updater-tone'] === 'warn',
  String(barNode(rView)?.props?.['data-dsh-updater-tone']))
ok('回滚时条子停在没走完的位置', percentText(rView) === '50%', String(percentText(rView)))
ok('回滚时给「关闭」不给「重新载入」', rView.buttons.map(textOf).includes('关闭')
  && !rView.buttons.map(textOf).includes('重新载入页面'), rView.buttons.map(textOf).join('|'))

/* ─────────────────────────── 徽标面板里的上次更新 ─────────────────────────── */

const panelRegistration = bootClientModule()
const panelModule = panelRegistration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require(${spec})`)
})
let panelComponent = null
panelModule.apply({
  ...zhCtx,
  slots: {
    inject: (_key, callback) => { callback(); return () => {} },
    register: (options, component) => {
      if (options.name === 'conversation.composer.dock') panelComponent = component
      return () => {}
    },
  },
})

globalThis.fetch = async () => ({ ok: true, json: async () => statusPayload({ lastUpdate: finishedRecord() }) })
resetHooks()
let panelView = render(panelComponent)
await sleep(20)
panelView = render(panelComponent)
panelView.button.props.onClick()
panelView = render(panelComponent)
ok('面板里画上次更新的进度条',
  panelView.nodes.some((node) => node.props?.['data-dsh-updater-panel-bar'] !== undefined),
  JSON.stringify(panelView.text))
ok('面板里列出每步耗时', panelView.text.includes('装核心 3分02秒'), JSON.stringify(panelView.text))
ok('面板里带上这次的总耗时', panelView.text.includes('已用时 3分07秒'), JSON.stringify(panelView.text))
ok('面板里的条子是绿的', panelView.nodes.find((node) => node.props?.['data-dsh-updater-bar'] !== undefined)
  ?.props?.['data-dsh-updater-tone'] === 'success')

const failed = checks.filter((check) => !check.pass)
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length > 0) process.exitCode = 1