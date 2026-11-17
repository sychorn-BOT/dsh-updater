/**
 * dsh-updater —— 浏览器半侧
 *
 * 两个座位：
 *   · conversation.composer.dock  输入框下面那个状态徽标（装的是哪一版、npm 上有没有新的）
 *   · shell.overlay               查到新版本时弹出来的窗口：现在更新 / 稍后
 *
 * 点「现在更新」= POST 一次 /dsh-updater/update。宿主写完 plan.json、拉起
 * scripts/update-dsh.ps1 就自己退场，脚本装完包再把 DSH 拉起来。
 * 所以这里只管三件事：问一句、把进度写出来、页面断开时把话说清楚。
 *
 * 数据只有一个来源：宿主半侧开的 /dsh-updater/status 和 /dsh-updater/update。
 * 这里不碰 npm（浏览器打 registry 会被 CORS 和代理折腾），也不拼版本号。
 */
window.__ModuleLoader__.load({
  id: 'dsh-updater',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ── 文案：跟着界面语言走 ── */
    const DICT = {
      en: {
        checking: 'checking for updates…',
        upToDate: 'up to date',
        available: 'update available',
        failed: 'update check failed',
        click: 'Click to see the full result',
        installed: 'Installed',
        file: 'Package',
        checked: 'Checked',
        error: 'Error',
        refresh: 'Refresh',
        collapse: 'Hide',
        refreshTitle: 'Ask npm again, skipping the host cache',
        none: '—',
        updateNow: 'Update now',
        later: 'Later',
        dialogTitle: 'A newer DSH is available',
        dialogIntro: 'Updating installs the new release and restarts DSH. This page disconnects; the restarted DSH opens its own tab.',
        dialogNote: 'Later leaves this version untouched. The badge under the composer asks again.',
        dialogSending: 'asking the host to start…',
        dialogScheduled: 'DSH is stopping in a moment…',
        pluginUpgrade: 'also updating',
        dialogApplying: 'installing the new version — this page is about to disconnect',
        dialogOffline: 'DSH is restarting. Use the tab it opens; if none appears, start DSH again.',
        dialogHostOld: 'The host half is still the old build. Restart DSH, then press Update now again.',
        dialogNoUpdate: 'No update is available any more.',
        dialogFailed: 'The update could not start: {error}',
        dialogManual: 'This install cannot update itself automatically ({reason}).',
        dismiss: 'Got it',
        lastUpdate: 'Last update',
        lastSucceeded: 'succeeded',
        lastFailed: 'failed',
        lastRolledBack: 'rolled back',
        updateTo: 'Update to',
      },
      zh: {
        checking: '检查更新中…',
        upToDate: '已是最新',
        available: '可更新',
        failed: '查更新失败',
        click: '点一下看完整结果',
        installed: '当前安装',
        file: '包位置',
        checked: '检查于',
        error: '错误',
        refresh: '重新检查',
        collapse: '收起',
        refreshTitle: '跳过宿主缓存，现在重新问一次 npm',
        none: '—',
        updateNow: '现在更新',
        later: '稍后',
        dialogTitle: 'DSH 有新版本了',
        dialogIntro: '更新会先停下 DSH，装好新版本再自动重启。这个页面会断开，重启后的 DSH 会自己打开新标签页。',
        dialogNote: '选「稍后」就不动这个版本；想再更新，点输入框下面的徽标。',
        dialogSending: '正在让宿主开始…',
        dialogScheduled: 'DSH 马上停下…',
        pluginUpgrade: '同时升级',
        dialogApplying: '正在装新版本，页面即将断开',
        dialogOffline: 'DSH 正在重启。等它打开新标签页；没开就手动再启动一次 DSH。',
        dialogHostOld: '宿主半侧还是旧版本，重启 DSH 之后这个按钮才会真的生效。',
        dialogNoUpdate: '现在没有可更新的版本了。',
        dialogFailed: '更新没能开始：{error}',
        dialogManual: '这个装法没法自动更新（{reason}）。',
        dismiss: '知道了',
        lastUpdate: '上次更新',
        lastSucceeded: '成功',
        lastFailed: '失败',
        lastRolledBack: '已回滚',
        updateTo: '更新到',
      },
    }

    function dictFor(localeId) {
      return String(localeId ?? '').toLowerCase().startsWith('zh') ? DICT.zh : DICT.en
    }

    /* ── 同一个页面里多个会话共用一份结果，不各查各的 ── */
    const shared = { at: 0, value: null, pending: null }
    const SHARED_MS = 60_000

    function statusUrl(force) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : window.location.href
      const url = new URL('dsh-updater/status', base)
      if (force) url.searchParams.set('refresh', '1')
      return url.href
    }

    function updateUrl() {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : window.location.href
      return new URL('dsh-updater/update', base).href
    }

    async function requestStatus(force) {
      if (!force && shared.value !== null && Date.now() - shared.at < SHARED_MS) return shared.value
      if (shared.pending !== null) return await shared.pending
      const run = (async () => {
        try {
          const response = await fetch(statusUrl(force), {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const json = await response.json()
          shared.at = Date.now()
          shared.value = json
          return json
        } catch (error) {
          return { ok: false, installed: shared.value?.installed ?? null, error: error?.message ?? String(error) }
        } finally {
          shared.pending = null
        }
      })()
      shared.pending = run
      return await run
    }

    /* ── 「稍后」记在浏览器里：同一个版本不再自动问，徽标还能点开 ── */
    const DISMISS_KEY = 'dsh-updater:dismissed-version'

    function readDismissed() {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(DISMISS_KEY)
      } catch {
        return null
      }
    }

    function writeDismissed(version) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(DISMISS_KEY, version)
      } catch {
        /* 隐私模式里存不了，那就下次再问一遍 */
      }
    }

    /* ── 弹窗的开/关放在这儿：徽标里的按钮和弹窗是两个组件 ── */
    const prompt = {
      open: false,
      listeners: new Set(),
      set(value) {
        if (this.open === value) return
        this.open = value
        for (const listener of [...this.listeners]) listener()
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
    }

    /** 宿主给的是 ISO 时间，按时区摊成本地的 YYYY-MM-DD HH:mm。 */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso === '') return null
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return null
      const pad = (n) => String(n).padStart(2, '0')
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /* ── 样式：只用宿主主题 token，容器和控件跟着明暗切换 ── */
    const CSS = `
[data-dsh-updater-root]{display:flex;flex-direction:column;min-width:0;max-width:100%;}
[data-dsh-updater]{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;
  border:0;background:transparent;padding:2px 4px;border-radius:6px;font:inherit;font-size:11px;
  line-height:16px;color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;text-align:left;}
[data-dsh-updater]:hover{background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);}
[data-dsh-updater]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px;}
[data-dsh-updater][disabled]{cursor:default;opacity:.75;}
[data-dsh-updater-dot]{flex:none;width:6px;height:6px;border-radius:3px;background:var(--dsh-updater-tone,var(--dsw-alias-state-idle-primary,#9aa0a6));}
[data-dsh-updater-text]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-dsh-updater-strong]{font-weight:500;color:var(--dsw-alias-label-primary,inherit);}
[data-dsh-updater-sep]{opacity:.45;padding:0 1px;}
[data-dsh-updater-panel]{display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 12px;
  margin:4px 0 2px 4px;padding:8px 10px;max-width:560px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:8px;
  background:var(--dsw-alias-bg-layer-1,transparent);font-size:11px;line-height:16px;}
[data-dsh-updater-k]{white-space:nowrap;color:var(--dsw-alias-label-secondary,#8a8f98);}
[data-dsh-updater-v]{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-primary,inherit);}
[data-dsh-updater-actions]{grid-column:1/-1;display:flex;gap:6px;margin-top:6px;}
[data-dsh-updater-act]{font:inherit;font-size:11px;line-height:16px;padding:2px 8px;border-radius:6px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;color:inherit;}
[data-dsh-updater-act]:hover{background:var(--dsw-alias-bg-layer-2,transparent);}
[data-dsh-updater-act][disabled]{cursor:default;opacity:.6;}
[data-dsh-updater-backdrop]{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;
  justify-content:center;padding:24px;background:rgba(6,8,12,.46);}
[data-dsh-updater-dialog]{width:min(430px,100%);max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;
  padding:18px 18px 14px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));
  background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-1,#fff));
  box-shadow:0 18px 48px rgba(0,0,0,.38);color:var(--dsw-alias-label-primary,inherit);
  font-size:13px;line-height:20px;}
[data-dsh-updater-dialog-title]{font-size:14px;line-height:22px;font-weight:600;margin:0 0 2px;}
[data-dsh-updater-versions]{display:flex;align-items:center;gap:8px;margin:10px 0 12px;font-size:12px;
  color:var(--dsw-alias-label-secondary,inherit);}
[data-dsh-updater-versions] b{font-weight:600;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums;}
[data-dsh-updater-arrow]{opacity:.5;}
[data-dsh-updater-dialog-text]{margin:0 0 10px;color:var(--dsw-alias-label-secondary,inherit);}
[data-dsh-updater-dialog-note]{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8f98);}
[data-dsh-updater-dialog-actions]{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;}
[data-dsh-updater-btn]{font:inherit;font-size:12px;line-height:18px;padding:6px 14px;border-radius:8px;
  cursor:pointer;border:1px solid transparent;}
[data-dsh-updater-btn]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px;}
[data-dsh-updater-btn="ghost"]{border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;color:inherit;}
[data-dsh-updater-btn="ghost"]:hover{background:var(--dsw-alias-bg-layer-2,transparent);}
[data-dsh-updater-btn="primary"]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#3b82f6));
  color:var(--dsw-alias-brand-text,#fff);}
[data-dsh-updater-btn="primary"]:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#2563eb));}
[data-dsh-updater-spin]{display:inline-block;width:10px;height:10px;border-radius:5px;margin-right:8px;
  vertical-align:-1px;background:var(--dsw-alias-state-warn-primary,#d97706);animation:dsh-updater-pulse 1.1s ease-in-out infinite;}
@keyframes dsh-updater-pulse{0%,100%{opacity:.35;transform:scale(.8);}50%{opacity:1;transform:scale(1);}}
`

    function Dot({ tone }) {
      return h('span', { 'data-dsh-updater-dot': '', style: { '--dsh-updater-tone': tone }, 'aria-hidden': true })
    }

    function useLocaleId(ctx) {
      const service = ctx.get('locale')
      const read = () => (typeof service?.getLocale === 'function' ? service.getLocale().active : 'en')
      const [id, setId] = React.useState(read)
      React.useEffect(() => {
        if (service === undefined || typeof service?.subscribe !== 'function') return undefined
        return service.subscribe(() => setId(read()))
      }, [])
      return id
    }

    function Badge({ ctx }) {
      const localeId = useLocaleId(ctx)
      const words = dictFor(localeId)
      const [state, setState] = React.useState({ kind: 'loading', data: shared.value })
      const [open, setOpen] = React.useState(false)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = React.useCallback(async (force) => {
        setState((prev) => ({ kind: 'checking', data: prev.data }))
        const data = await requestStatus(force)
        if (!alive.current) return
        setState({ kind: data?.ok === true ? 'ok' : 'error', data })
      }, [])

      React.useEffect(() => {
        load(false)
        return () => {
          alive.current = false
        }
      }, [])

      const data = state.data ?? {}
      const installed = typeof data.installed === 'string' ? data.installed : null
      const latest = typeof data.latest === 'string' ? data.latest : null
      const update = data?.ok === true && data.updateAvailable === true
      const idle = state.kind === 'loading' || state.kind === 'checking'

      const tone = idle
        ? 'var(--dsw-alias-state-idle-primary,#9aa0a6)'
        : state.kind === 'error'
          ? 'var(--dsw-alias-state-error-primary,#dc2626)'
          : update
            ? 'var(--dsw-alias-state-warn-primary,#d97706)'
            : 'var(--dsw-alias-state-success-primary,#16a34a)'

      let tail
      if (idle) tail = words.checking
      else if (state.kind === 'error') tail = words.failed
      else if (update && latest !== null) tail = `${latest} ${words.available}`
      else if (installed === null) tail = words.failed
      else tail = words.upToDate

      const parts = []
      if (installed !== null) {
        parts.push(h('span', { key: 'v', 'data-dsh-updater-strong': '' }, `DSH ${installed}`))
        parts.push(h('span', { key: 'sep', 'data-dsh-updater-sep': '' }, '·'))
      }
      parts.push(h('span', { key: 'tail' }, tail))

      const title = state.kind === 'error'
        ? `dsh-updater: ${data.error ?? 'unknown error'}`
        : words.click

      /* ── 展开的明细：就是那份输出，摊在端口上的界面里 ── */
      const rows = []
      const row = (key, label, value) => {
        if (value === null || value === undefined || value === '') return
        rows.push(h('span', { key: `${key}-k`, 'data-dsh-updater-k': '' }, label))
        rows.push(h('span', { key: `${key}-v`, 'data-dsh-updater-v': '', title: String(value) }, String(value)))
      }
      row('installed', words.installed, installed === null ? words.none : `@deepseek-ai/dsh ${installed}`)
      row('file', words.file, typeof data.installedFile === 'string' ? data.installedFile : words.none)
      row('latest', 'npm latest', data.channels?.latest ?? latest ?? words.none)
      row('next', 'npm next', data.channels?.next ?? words.none)
      row('alpha', 'npm alpha', data.channels?.alpha ?? words.none)
      row('channel', 'channel', typeof data.channel === 'string' ? data.channel : null)
      row('checked', words.checked, formatTime(data.checkedAt) ?? words.none)
      row('lastUpdate', words.lastUpdate, lastUpdateText(data.lastUpdate, words))
      row('error', words.error, typeof data.error === 'string' && data.error !== '' ? data.error : null)

      const actions = []
      if (update && data.canAutoUpdate === true) {
        actions.push(h('button', {
          key: 'update',
          type: 'button',
          'data-dsh-updater-act': '',
          title: `${words.updateTo} ${latest ?? ''}`.trim(),
          onClick: () => prompt.set(true),
        }, words.updateNow))
      }
      actions.push(h('button', {
        key: 'refresh',
        type: 'button',
        'data-dsh-updater-act': '',
        disabled: idle,
        title: words.refreshTitle,
        onClick: () => {
          if (!idle) load(true)
        },
      }, words.refresh))
      actions.push(h('button', {
        key: 'collapse',
        type: 'button',
        'data-dsh-updater-act': '',
        onClick: () => setOpen(false),
      }, words.collapse))

      const panel = open
        ? h('div', {
            key: 'panel',
            'data-dsh-updater-panel': '',
            role: 'group',
            'aria-label': 'DSH update details',
          },
            ...rows,
            h('div', { key: 'actions', 'data-dsh-updater-actions': '' }, ...actions))
        : null

      return h(React.Fragment, null,
        h('style', { key: 'css', dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { key: 'root', 'data-dsh-updater-root': '' },
          h('button', {
            key: 'badge',
            type: 'button',
            'data-dsh-updater': '',
            'aria-expanded': open,
            title,
            'aria-label': `DSH ${installed ?? ''} ${tail}`.trim(),
            onClick: () => setOpen((prev) => !prev),
          },
            h(Dot, { tone }),
            h('span', { 'data-dsh-updater-text': '' }, parts)),
          panel))
    }

    function lastUpdateText(last, words) {
      if (last === null || last === undefined) return null
      const route = `${last.from ?? '?'} → ${last.to ?? '?'}`
      const outcome = last.running === true
        ? words.checking
        : last.ok === true
          ? words.lastSucceeded
          : last.rollback === true
            ? `${words.lastFailed}（${words.lastRolledBack}）`
            : words.lastFailed
      const at = formatTime(last.at)
      return [route, outcome, at].filter((part) => part !== null && part !== '').join(' · ')
    }

    /**
     * 查到新版本时弹出来的那个窗口。
     *
     * 关掉以后同一条记录还会留在 prompt 里：徽标面板里的「现在更新」把 open 重新置 true
     * 就能再弹一次，不用再问一遍宿主。
     */
    function UpdatePrompt({ ctx }) {
      const localeId = useLocaleId(ctx)
      const words = dictFor(localeId)
      const [data, setData] = React.useState(shared.value)
      const [open, setOpen] = React.useState(prompt.open)
      const [phase, setPhase] = React.useState('idle')
      const [error, setError] = React.useState(null)
      const [extra, setExtra] = React.useState(null)
      const primary = React.useRef(null)
      const asked = React.useRef(false)

      React.useEffect(() => prompt.subscribe(() => setOpen(prompt.open)), [])

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          const result = await requestStatus(false)
          if (!alive) return
          setData(result)
          if (asked.current) return
          asked.current = true
          const latest = typeof result?.latest === 'string' ? result.latest : null
          if (result?.ok === true && result.updateAvailable === true && latest !== null && readDismissed() !== latest) {
            prompt.set(true)
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const latest = typeof data?.latest === 'string' ? data.latest : null
      const installed = typeof data?.installed === 'string' ? data.installed : null

      function close() {
        if (phase === 'idle') writeDismissed(latest)
        setPhase('idle')
        setError(null)
        prompt.set(false)
      }

      function startUpdate() {
        if (phase !== 'idle') return
        setPhase('sending')
        setError(null)
        ;(async () => {
          try {
            const response = await fetch(updateUrl(), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { accept: 'application/json', 'x-dsh-updater-action': 'update' },
            })
            if (response.status === 404) {
              setPhase('hostOld')
              return
            }
            const json = await response.json().catch(() => null)
            if (!response.ok || json?.ok !== true) {
              setError(json?.error ?? `HTTP ${response.status}`)
              setPhase('error')
              return
            }
            if (Array.isArray(json?.plugins) && json.plugins.length > 0) {
              setExtra(json.plugins.map((entry) => entry.name + ' ' + entry.from + ' → ' + entry.to).join('、'))
            }
            setPhase('scheduled')
          } catch (failure) {
            setError(failure?.message ?? String(failure))
            setPhase('error')
          }
        })()
      }

      /* 宿主说「开始」以后再给 1.5s：那之后进程就该退出了，界面只剩等待。 */
      React.useEffect(() => {
        if (phase !== 'scheduled') return undefined
        const timer = setTimeout(() => setPhase('applying'), 1500)
        return () => clearTimeout(timer)
      }, [phase])

      /* 服务器什么时候没的，就是这个轮询第一次失败的时候。 */
      React.useEffect(() => {
        if (phase !== 'applying') return undefined
        let alive = true
        let failures = 0
        ;(async () => {
          while (alive) {
            try {
              const response = await fetch(updateUrl(), {
                credentials: 'same-origin',
                headers: { accept: 'application/json' },
              })
              if (!response.ok) failures += 1
              else {
                const json = await response.json().catch(() => null)
                if (json?.phase === 'failed') {
                  setError(json.error ?? null)
                  setPhase('error')
                  return
                }
              }
            } catch {
              failures += 1
            }
            if (!alive) return
            if (failures >= 2) {
              setPhase('offline')
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        })()
        return () => {
          alive = false
        }
      }, [phase])

      React.useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onKey = (event) => {
          if (event.key === 'Escape' && phase === 'idle') close()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, phase])

      React.useEffect(() => {
        if (open && phase === 'idle' && typeof primary.current?.focus === 'function') primary.current.focus()
      }, [open, phase])

      if (!open || latest === null) return null

      const canAuto = data?.canAutoUpdate === true
      const busy = phase === 'sending' || phase === 'scheduled' || phase === 'applying'
      const terminal = phase === 'error' || phase === 'hostOld' || phase === 'noUpdate' || phase === 'offline'

      let body
      if (phase === 'sending') body = words.dialogSending
      else if (phase === 'scheduled') body = words.dialogScheduled
      else if (phase === 'applying') body = words.dialogApplying
      else if (phase === 'offline') body = words.dialogOffline
      else if (phase === 'hostOld') body = words.dialogHostOld
      else if (phase === 'noUpdate') body = words.dialogNoUpdate
      else if (phase === 'error') body = words.dialogFailed.replace('{error}', error ?? words.none)
      else if (!canAuto) body = words.dialogManual.replace('{reason}', String(data?.updateBlockedBy ?? words.none))
      else body = words.dialogIntro

      const actions = []
      if (phase === 'idle') {
        actions.push(h('button', {
          key: 'later',
          type: 'button',
          'data-dsh-updater-btn': 'ghost',
          onClick: close,
        }, canAuto ? words.later : words.dismiss))
        if (canAuto) {
          actions.push(h('button', {
            key: 'now',
            ref: primary,
            type: 'button',
            'data-dsh-updater-btn': 'primary',
            onClick: startUpdate,
          }, words.updateNow))
        }
      } else if (terminal) {
        actions.push(h('button', {
          key: 'ok',
          type: 'button',
          'data-dsh-updater-btn': 'ghost',
          onClick: () => {
            setPhase('idle')
            setError(null)
            prompt.set(false)
          },
        }, words.dismiss))
      }

      return h(React.Fragment, null,
        h('style', { key: 'css', dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', {
          key: 'backdrop',
          'data-dsh-updater-backdrop': '',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && phase === 'idle') close()
          },
        },
          h('div', {
            key: 'dialog',
            'data-dsh-updater-dialog': '',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-updater-dialog-title',
          },
            h('div', { key: 'title', 'data-dsh-updater-dialog-title': '', id: 'dsh-updater-dialog-title' }, words.dialogTitle),
            h('div', { key: 'versions', 'data-dsh-updater-versions': '' },
              h('b', { key: 'from' }, installed ?? words.none),
              h('span', { key: 'arrow', 'data-dsh-updater-arrow': '', 'aria-hidden': true }, '→'),
              h('b', { key: 'to' }, latest)),
            h('p', { key: 'text', 'data-dsh-updater-dialog-text': '' },
              busy ? h('span', { key: 'spin', 'data-dsh-updater-spin': '', 'aria-hidden': true }) : null,
              body),
            extra !== null && busy
              ? h('p', { key: 'extra', 'data-dsh-updater-dialog-note': '' }, `${words.pluginUpgrade}：${extra}`)
              : null,
            phase === 'idle'
              ? h('p', { key: 'note', 'data-dsh-updater-dialog-note': '' }, words.dialogNote)
              : null,
            actions.length > 0
              ? h('div', { key: 'actions', 'data-dsh-updater-dialog-actions': '' }, ...actions)
              : null)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-updater',
          order: 2,
        }, (props) => h(Badge, { ctx, ...props })))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-updater-update',
          order: 90,
        }, (props) => h(UpdatePrompt, { ctx, ...props })))
      },
    }
  },
})
