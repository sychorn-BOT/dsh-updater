# dsh-updater

在编排器（输入框）下面挂一个状态徽标，回答一个问题：**这台机器上的 DSH 是不是最新的？**
查到新版本时弹一个窗口问一句：**现在更新吗？** 选「现在更新」就自己装、自己重启。

- 当前安装版本：顺着启动入口往上找 `@deepseek-ai/dsh` 的 `package.json`，不靠环境变量猜
- npm 上的最新版本：GET `https://registry.npmjs.org/-/package/@deepseek-ai%2fdsh/dist-tags`
- 点一下徽标 = 展开明细（各 channel、包位置、检查时间、上次更新的结论 + 每步耗时的进度条）；再点收起
- 更新过程有进度条：准备那几步是真的往前走；装的时候 DSH 停着，条子流动着等；装完把每一步花了多久读回来
- 模型也能自己问：工具 `dsh_check_update`（参数 `refresh: true` 强制重查）
- 模型还能自检：工具 `dsh_update_doctor`——真跑一次 powershell 和 npm，看这台机器上更新到底卡在哪

## 三个座位

| 半侧 | 文件 | 干什么 |
| --- | --- | --- |
| 宿主 | `lib/index.js` | `GET /dsh-updater/status`、`GET/POST /dsh-updater/update`、工具 `dsh_check_update` + `dsh_update_doctor` |
| 浏览器 | `client.js` | `conversation.composer.dock` 里的徽标 + `shell.overlay` 里的更新弹窗 |
| 执行 | `scripts/update-dsh.ps1` | 停 DSH → 备份 → `npm install` → 校验 → 回滚/重启 |

## 点「现在更新」之后发生了什么

```
浏览器           宿主（旧进程）                       update-dsh.ps1（脱开宿主跑）
  │  POST /update      │                                        │
  ├───────────────────>│ 再查一次 npm，确认真有新版本            │
  │                    │ 插件闸门：谁不认新核心、升到哪一版      │
  │                    │ 自检：powershell / npm / 脚本 -DryRun   │
  │                    │ 写 plan.json（版本、核心树、pid、插件） │
  │<───────────────────┤ 200 { phase: "scheduled", plugins }    │
  │                    ├──────── spawn powershell -File ───────>│
  │  「DSH 马上停下…」  │ 1.2s 后刷会话日志、process.exit(0)      │
  │                    ╳                                        │ 等旧进程退出
  │  页面断开           │                                        │ 备份 package.json / lock
  │                    │                                        │ npm install @deepseek-ai/dsh@X
  │                    │                                        │ 校验核心确实换到 X
  │                    │                                        │ pnpm add <插件>@<版本>（需跟进的）
  │                    │                                        │ 起 DSH（新窗口 + 新标签页）
  │<════════════════════════════════════════════════════════════┤
```

- **点之前**：自检四步——`powershell` 真跑一次 `exit 7`、`npm --version`、**拿真的更新脚本跑一遍 `-DryRun`**、**插件兼容闸门**（见下）。任何一步不过就直接 503，**DSH 不会停**，弹窗里写明是哪一步、PowerShell 原话是什么。宿主拉不起子进程的机器就停在这儿。直接拉 `powershell.exe` 被拦（有些杀软只挡 node → powershell）时会经 `cmd.exe` 中转一次再试。
- **装之前**：`npm install` 失败或校验不过 → 还原 `package.json` / `package-lock.json`、重新装回旧版本、照样把旧 DSH 拉起来。界面回来时徽标是红点，明细里有原因。
- **插件**：要跟进的那几个在**核心换好、DSH 还没起来**的窗口里用 profile 自己的 pnpm 装。装失败 → 还原 profile 的 `package.json`/`pnpm-lock.yaml` + 还原核心 → 起旧版本。
- **装之后**：新版本起来了但 40 秒内没监听端口 → 同样回滚（profile 和核心都还原）再拉起。
- 宿主退场前 1.2 秒会盯着脚本：脚本要是先死了，这次就不退场，弹窗里写明退出码。
- 所以「更新失败」的最终状态是**旧的还能用**，不是一台起不来的机器。

日志和结论都写在核心树里，重启后徽标还能读回来：

```
<核心树>\.dsh-updater\
  update-<时间>.log        这次更新干了什么
  bootstrap.log            脚本落地第一行（连 plan 都读不到时，只剩这一份）
  spawn-<时间>.out         powershell 自己的 stderr（脚本解析失败时看这里）
  npm-install-out/err.log  npm 自己的输出
  pnpm-<tag>-out/err.log   装插件时的 pnpm 输出
  plan-<时间>.json         宿主交给脚本的那份计划
  backup-<时间>\           装之前的 package.json / package-lock.json
  last-update.json         上次的结论 + 每一步的进度（徽标「上次更新」和进度条都读它）
```

## 进度条

按下「现在更新」以后，弹窗里那条进度分三段：

| 阶段 | 谁在报进度 | 条子长什么样 |
| --- | --- | --- |
| 准备：查 npm → 插件闸门 → 写计划 → 自检 → 拉起脚本 | 宿主自己（`update.steps`），界面每 350ms 问一次 `/dsh-updater/update` | 真的往前走，写明第几步、自检到哪一项 |
| 装：停 DSH → 备份 → 装核心 →（装插件）→ 起 DSH | 没人。DSH 已经停了，那个端口上什么都没有 | 流动，只报已用时 |
| 收尾 | 新 DSH 起来以后，从 `<核心树>\.dsh-updater\last-update.json` 读回脚本记的那几笔 | 走到头，列出每一步花了多久 |

中间那段没法直播，原因很实在：换核心树之前 DSH 必须停掉（文件被占着时 npm 装不进去），
停掉以后就没有服务能回答「现在到哪一步了」。所以脚本改成把进度写在磁盘上——每走完一步
重写一次 `last-update.json`；新 DSH 一启动，状态接口就能把那份记录读回来，弹窗接着把条子走完。

那份记录长这样（`Set-Content -Encoding UTF8` 写的，是带 BOM 的 UTF-8，宿主读之前先剥掉）：

```json
{
  "ok": true, "running": false, "rollback": false,
  "from": "0.2.2-rc.5", "to": "0.2.2-rc.6",
  "startedAt": "2026-11-20T04:16:10Z", "updatedAt": "2026-11-20T04:16:13Z",
  "step": null, "total": 4,
  "steps": [
    { "id": "stop", "ms": 8, "at": "..." },
    { "id": "backup", "ms": 9, "at": "..." },
    { "id": "install", "ms": 837, "at": "..." },
    { "id": "start", "ms": 2066, "at": "..." }
  ],
  "error": null, "logFile": ".../update-20261120-121610.log"
}
```

- `total`：这次一共几步（没插件 4 步，有插件 5 步）
- `step`：现在停在哪一步；失败时就是卡住的那一步（装不上 = `install`）
- `steps`：走完的步骤，按顺序，带耗时
- `running`：脚本还活着。新 DSH 起来时可能还看到它，再等一秒就是结论

徽标面板里的「上次更新」读的是同一份记录：一根小条 + 每步耗时，成功绿、回滚橙、失败红。
重启之后想再看一眼，`GET /dsh-updater/status` 的 `lastUpdate` 里就是它。

## 什么时候不给自动更新

只在这几种情况下弹窗只说明情况、不给按钮（`updateBlockedBy` 里带原因）：

- `allowUpdate: false`（配置里关掉了）
- 读不出本机装的哪一版（`installed unknown`）
- `@deepseek-ai/dsh` 不在某个 `node_modules` 底下（全局安装那种装法，`npm install` 改不了）
- `scripts/update-dsh.ps1` 不在

## 插件兼容闸门

换核心版本会连带改 DSH 的插件契约，而 loader 自己的规矩是：插件的 `engines.dsh`（没有就看
`@deepseek-ai/dsh*` 的 peer）不满足运行时版本，**整条 bundle 层被跳过**——不是警告，是那个插件的
入口根本不加载。

所以更新前拿 `dsh-app-boot` 的 `evaluatePluginCompatibility`（loader 用的同一个函数）把当前
profile 的每个 bundle 对着**目标版本**算一遍：

- 跳过 `@deepseek-ai/*`：核心自带的 bundle 跟核心一起换，不比
- 认 profile 里已登记的版本豁免（`compatibility.json` / 插件管理器的豁免记录）
- 挡路的再分两种：
  - **升一版就能配**（registry 上的 latest 认目标版本）→ 不算挡路，**跟着核心一起装**
  - **哪一版都不认** → 真挡路，更新直接被拒，弹窗里写清谁、要求什么

### 为什么插件不能在插件市场先升级

插件市场（`dsh-plugin-manager`）的安装检查拿的是**当前运行时**的版本。`dsh-ops@0.5.5` 要求
`>=0.2.2-rc.1`，所以在 0.2.1-rc.5 上装它会被判 `incompatible-version` 直接拒——顺序上根本走不通。

唯一能同时成立的时刻，就是「核心已经换到磁盘上、DSH 还没起来」的那几秒。所以更新脚本在
`npm install` 之后、起服务之前，用 profile 自己的 pnpm 把要跟进的插件装上，然后一次启动。
装失败就把 profile 和核心一起还原，起旧版本。

## 配置

`cordis.patch.yml`（或用户层按 `id: dsh-updater` 覆盖 `config`）：

```yaml
- insert:
    - id: dsh-updater
      name: 'dsh-updater'
      config:
        channel: latest        # latest | next | alpha
        registry: https://registry.npmjs.org
        cacheSeconds: 600
        allowUpdate: true      # false = 只查、不弹更新按钮、POST 一律 403
```

## 状态语义

| 徽标 | 含义 |
| --- | --- |
| 灰点 · 检查更新中… | 请求还没回来 |
| 绿点 · 已是最新 | npm 的 `channel` 标签不高于本机版本 |
| 橙点 · 可更新 | npm 上有更高的版本（`channel` 由配置决定）；点徽标能看到「现在更新」 |
| 红点 · 查更新失败 | 连不上 registry / 本机版本读不出来，`title` 里带原因 |

弹窗里选「稍后」：这个版本不再自动弹（记在浏览器的 `localStorage`），徽标上的入口还在。

## 本地验收

```bash
npm test                          # 宿主 + 浏览器两个半侧的离线检查
node tests/dry-run.mjs            # 只跑更新脚本的 -DryRun：核对路径、npm、版本，什么都不动
node tests/compat-preview.mjs X   # 预演：profile 里的插件对着核心 X 会不会被挡（只读）
node tests/script-flow.mjs        # 真跑一遍更新脚本（假核心树、假 npm、假 DSH），只看它留下的进度记录
```

`tests/dry-run.mjs` 要从普通终端跑：DSH 沙盒里的进程拉不起 powershell（EPERM）。

装好以后想知道这台机器到底能不能自更新，让模型跑一次工具 `dsh_update_doctor`——它真从宿主
拉一次 powershell、npm 和更新脚本的 `-DryRun`，把失败的那一步和原因打出来。

改完 `lib/index.js` 或 `client.js` 要**重启一次 DSH** 才生效——宿主半侧是模块代码（HMR 只重载配置，
模块根是 opt-in），浏览器半侧的 bundle 也按启动时的产物版本缓存。
