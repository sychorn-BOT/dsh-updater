/**
 * 预演：把当前 profile 的 bundle 对着某个核心版本算一遍兼容性（不动任何东西）。
 *
 * 用的是 DSH loader 自己那套判定（dsh-app-boot 的 evaluatePluginCompatibility），
 * 跟插件里那道闸门同源——所以这里说「会被挡」，更新时也会被挡。
 *
 *   node tests/compat-preview.mjs 0.2.2-rc.1
 *   node tests/compat-preview.mjs 0.2.2-rc.1 --profile E:\dsh\dsh-home\profiles\web
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const target = process.argv[2] ?? '0.2.2-rc.1'
const profileArgIndex = process.argv.indexOf('--profile')
const profileDir = profileArgIndex > 0 ? process.argv[profileArgIndex + 1] : 'E:\\dsh\\dsh-home\\profiles\\web'
const appBoot = process.env.DSH_APP_BOOT ?? 'E:\\dsh\\dsh\\node_modules\\@deepseek-ai\\dsh-app-boot\\lib\\index.js'

if (!existsSync(appBoot)) {
  console.error(`找不到 dsh-app-boot：${appBoot}（用 DSH_APP_BOOT 指定）`)
  process.exit(2)
}
const { evaluatePluginCompatibility } = await import(pathToFileURL(appBoot).href)

const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = profile.dsh?.profile?.bundles ?? []
const farmDir = join(dirname(profileDir), 'node_modules')

function exemptionsOf() {
  for (const file of ['compatibility.json', 'cordis.compatibility.json', '.dsh-compatibility.json']) {
    const path = join(profileDir, file)
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
    }
  }
  return {}
}

const exemptions = exemptionsOf()
console.log(`目标核心版本：${target}`)
console.log(`profile：${profileDir}（${bundles.length} 个 bundle）\n`)

let blocked = 0
for (const name of bundles) {
  // 核心自带的 bundle 会跟核心一起换，不参与比较
  if (name.startsWith('@deepseek-ai/')) {
    console.log(`  -- ${name}（核心自带，跳过）`)
    continue
  }
  let manifest = null
  for (const dir of [join(profileDir, 'node_modules'), farmDir]) {
    const file = join(dir, name, 'package.json')
    if (existsSync(file)) { manifest = JSON.parse(readFileSync(file, 'utf8')); break }
  }
  if (manifest === null) { console.log(`  ?  ${name}（找不到 manifest）`); continue }

  const verdict = evaluatePluginCompatibility(manifest, exemptions, target)
  if (verdict === undefined || verdict.exempted === true) {
    console.log(`  ok ${name}@${manifest.version}`)
    continue
  }
  blocked += 1
  const requirements = Object.entries(verdict.requirements ?? {}).map(([field, range]) => `${field} ${range}`).join(', ')
  console.log(`  ✗  ${name}@${manifest.version}  要求 ${requirements}`)
}

console.log(`\n会被挡下的 bundle：${blocked}`)
if (blocked > 0) {
  console.log('先升级这些插件（或登记版本豁免），再更新核心，否则重启后它们会被整层跳过。')
  process.exitCode = 1
}
