// 扫描结果的落盘与刷新：把「本地 purge 目录」变成两份产物。
//
//   state/catalog.json  ← 完整条目表（含正文），只给 hooks.js 读
//   page/catalog.js     ← 页面快照（window.PURGE_CATALOG，不含正文），页面用 <script> 读
//
// 页面在沙箱帧里，不能 fetch、不能读盘；所以「后端 → 页面」的唯一通道就是 page/ 下这份脚本。
// 页面侧的「导入」也走同一条思路：把要导入的路径写进 options.imports，宿主重启插件后
// 这里（Bun 侧）把文件复制进 state/imports，再重新扫描，页面下次刷新就看到结果。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, normalize } from 'node:path'
import {
  LIMITS,
  expandHome,
  mergeEntries,
  scan,
  snapshotOf,
} from './inventory.mjs'
import { readState } from './agentpurge.mjs'
import { bundled as bundledScan } from './bundled.mjs'
import { resolve as resolvePlan } from './plan.mjs'

const IMPORT_EXT = new Set(['.zip', '.md', '.markdown', '.txt', '.json'])

/**
 * stateRoot 是「这个插件的可写数据」该放哪。
 *
 * 以前放在包目录里（<包根>/state）。npm 更新是整目录替换，于是每次升级都会把
 * 用户导入的副本、上一次扫描的 catalog.json 一起删掉——快照每次都从 v1 重来。
 * 所以挪到用户目录下，跨版本存活；包目录里只留 page/catalog.js 这一份派生快照，
 * 因为它必须能被 HTTP 静态服务读到。
 *
 * 可以用 PURGE_STATE_DIR 覆盖（测试与多实例都要）。
 */
export function stateRoot() {
  const override = process.env.PURGE_STATE_DIR
  if (override && override.trim()) return expandHome(override.trim())
  return join(homedir(), '.magpie', 'purge')
}

export function paths(here, root = stateRoot()) {
  return {
    here,
    stateDir: root,
    importsDir: join(root, 'imports'),
    catalogFile: join(root, 'catalog.json'),
    lastFile: join(root, 'last.json'),
    // 页面要读的两份产物，都落在包内 page/：
    //   catalog.js  —— 只有元数据，不含正文。页面用 <script src> 载入，任何 CSP 都通得过。
    //   catalog.json —— 完整快照（含正文）。页面用 page/hostread.js 取：
    //                   fetch 被 CSP 拦时请宿主窗口代取（magpie 的 asset 通道）。
    // 拆开的原因是正文：内置技能是一批红队手册，整段内联进 .js 会让脚本引擎
    // 把它当可疑脚本判（Defender 报过 Trojan:Script/Wacatac.C!ml）。
    snapshotFile: join(here, 'page', 'catalog.js'),
    snapshotJsonFile: join(here, 'page', 'catalog.json'),
    // 旧版本的 state/（在包目录里），用于一次性迁移
    legacyStateDir: join(here, 'state'),
  }
}

/**
 * ensurePaths 决定这一次实际用哪个 state 目录。
 *
 * 优先用户目录（跨升级存活）。万一建不出来——沙箱、只读家目录、权限被收紧——
 * 退回包内 state/。宁可退回一个会被升级清掉的位置，也好过整个扫描直接抛出去：
 * 那会让页面永远停在空壳上，而且没有任何线索。
 */
export function ensurePaths(here, explicit = '') {
  const want = explicit || stateRoot()
  try {
    mkdirSync(want, { recursive: true })
    return paths(here, want)
  } catch {
    const fallback = join(here, 'state')
    try {
      mkdirSync(fallback, { recursive: true })
    } catch {
      /* 连包目录都写不了：交给调用方去失败，但至少路径是对的 */
    }
    return paths(here, fallback)
  }
}

/**
 * migrateLegacyState 把旧位置（包目录内 state/）的数据搬到新位置。
 *
 * 只在目标还没有对应文件时搬，不覆盖——用户可能已经在新位置跑过一轮了。
 * 搬完不删旧目录：万一搬一半失败，原件还在。
 */
export function migrateLegacyState(p) {
  const moves = [
    [p.importsDir, 'imports'],
    [p.catalogFile, 'catalog.json'],
    [p.lastFile, 'last.json'],
  ]
  let moved = 0
  for (const [target, rel] of moves) {
    const src = join(p.legacyStateDir, rel)
    if (!existsSync(src)) continue
    if (existsSync(target)) continue
    try {
      mkdirSync(dirname(target), { recursive: true })
      if (statSync(src).isDirectory()) {
        mkdirSync(target, { recursive: true })
        for (const name of readdirSync(src)) {
          const from = join(src, name)
          if (!statSync(from).isFile()) continue
          copyFileSync(from, join(target, name))
          moved++
        }
      } else {
        copyFileSync(src, target)
        moved++
      }
    } catch {
      /* 迁移失败不该让扫描挂掉：新位置照样能重新扫出来 */
    }
  }
  return moved
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

const sha = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16)

/** sourceSignature 是「这次要不要重扫」的判断依据：目录 mtime + 导入请求 + 强制刷新戳 + 包内专家。 */
/**
 * sourceSignature 决定「这次要不要重扫」。
 *
 * 现在只剩两处会变：导入请求（imports）与随包内容（bundledEntries）。
 * 不再把磁盘目录的 mtime 算进来——那等于每次磁盘有动静就重扫一遍。
 */
function sourceSignature(imports = [], refreshAt = 0, bundledEntries = []) {
  const own = bundledEntries.map((e) => `${e.id}:${e.digest}`).join(',')
  return sha([imports.map((i) => `${i.path}@${i.at}`).join(','), refreshAt, own].join('|'))
}

/**
 * loadCatalog 读上一次的完整条目表；没有就当成空的。
 */
export function loadCatalog(p) {
  return readJson(p.catalogFile, { version: 0, generatedAt: 0, entries: [], sources: [], rejected: [], imports: [] })
}

/** lastApplied 是 hooks 记下的最近一次改写记录；页面用它回答「上一次生效是什么时候」。 */
export function loadLast(p) {
  return readJson(p.lastFile, null)
}

/**
 * ownOptions 从 magpie 自己的 plugins.json 里读回「这个插件」的 options。
 *
 * 为什么需要它：网关钩子的 onRequest 只有真的来了请求才会被调用，而插件页要能
 * 在没有任何流量时也显示条目。宿主在改 options 后会重建插件宿主进程（我们的
 * 模块随之重新加载），所以模块加载时读一次 plugins.json 就能拿到最新设置。
 *
 * 找不到就返回 null，让调用方退回默认来源；读不到不算错。
 */
export function ownOptions(here, env = process.env) {
  const dirs = []
  const xdg = String(env.XDG_CONFIG_HOME || '').trim()
  if (xdg) dirs.push(join(xdg, 'magpie'))
  dirs.push(join(homedir(), '.config', 'magpie'))
  const want = normalize(here).toLowerCase()
  for (const dir of dirs) {
    const file = join(dir, 'plugins.json')
    if (!existsSync(file)) continue
    const data = readJson(file, null)
    const rows = Array.isArray(data?.plugins) ? data.plugins : []
    for (const row of rows) {
      if (!row || typeof row.spec !== 'string') continue
      const spec = expandHome(row.spec, dir).toLowerCase()
      if (spec !== want) continue
      return row.options && typeof row.options === 'object' ? row.options : {}
    }
  }
  return null
}

/**
 * sync 重新清点来源目录，必要时处理导入请求，然后写两份产物。
 * @returns {{ catalog: object, changed: boolean, snapshot: object }}
 */
export function sync(here, options = {}, { force = false, limits = LIMITS, now = Date.now(), stateDir = '' } = {}) {
  const p = ensurePaths(here, stateDir)
  // 先把旧位置（包目录内 state/）的数据接过来，再做后面的读写。
  migrateLegacyState(p)
  mkdirSync(p.stateDir, { recursive: true })
  mkdirSync(p.importsDir, { recursive: true })

  // 只扫两处：包内随包内容（bundledRows）与 state/imports（用户导入的副本）。
  // 不再扫用户配的任意目录——那是「它会自己去翻我的磁盘」的来源，默认关掉更符合预期。
  const imports = Array.isArray(options.imports) ? options.imports.filter((i) => i && typeof i.path === 'string') : []
  const previous = loadCatalog(p)
  // 包内专家技能先读出来：它们随包走，签名也要算进它们，
  // 否则插件更新后（新增/改写专家）会因为「来源没变」而一直用旧表。
  const bundledRows = bundledScan(here)
  const signature = sourceSignature(imports, options.refreshAt ?? 0, bundledRows.entries)

  if (!force && previous.signature === signature) {
    // 条目没变，但快照里还有会变的东西：options（模式/启用人设）、last.json、
    // agent-purge 的 state、技能包标记。以前这里直接 return，快照文件于是一个字节
    // 都不更新——用户改完模式、来了一次真实请求，页面上「最近一次生效」还是空的。
    const snapshot = snapshotFrom(p, previous, options, now)
    const wrote = writeSnapshotIfChanged(p, snapshot)
    return { catalog: previous, changed: false, snapshot, snapshotWritten: wrote.ok, snapshotError: wrote.error }
  }

  const importRows = applyImports(p, imports, previous, now)
  // 只有导入目录参与扫描；用户没导入就只剩包内那 9 位专家 + 1 份底座人设。
  const scanned = scan([p.importsDir], { limits, now })
  const { entries: scannedEntries, duplicates } = mergeEntries(scanned.entries, previous.entries)
  // 包内专家技能永远在场：不参与「来源」的增删，也不吃版本号（它随包走，不是用户导入的）。
  const entries = [...bundledRows.entries, ...scannedEntries]
  // 重复不算「拒绝」：同一个目录每次重扫都会碰上它们，写进拒绝记录会把真正的问题埋掉。
  const rejected = scanned.rejected

  const catalog = {
    version: (previous.version || 0) + 1,
    generatedAt: now,
    signature,
    sources: [...(bundledRows.ok ? [{ path: bundledRows.dir, ok: true, count: bundledRows.entries.length, error: '', bundled: true }] : []), ...scanned.sources],
    entries,
    rejected,
    duplicates: duplicates.map((d) => ({ name: d.name, rel: d.source.rel, root: d.source.root })),
    imports: importRows,
  }
  // 落盘前把正文全部摘掉：state/catalog.json 以前是「所有手册的合集副本」，
  // 被 Defender 当成脚本载荷反复上载。正文始终留在原文件里，
  // 注入时由 hooks.js 按 source.root/rel 现读（见 builtinText）。
  const persisted = { ...catalog, entries: entries.map((e) => (e.text ? { ...e, text: '' } : e)) }
  writeFileSync(p.catalogFile, JSON.stringify(persisted, null, 2), 'utf8')
  const snapshot = snapshotFrom(p, catalog, options, now)
  const wrote = writeSnapshotIfChanged(p, snapshot)
  return { catalog, changed: true, snapshot, snapshotWritten: wrote.ok, snapshotError: wrote.error }
}

/** snapshotFrom 合成页面快照：条目元数据 + 当前设置 + 「这次会注入什么」的判定。 */
export function snapshotFrom(p, catalog, options, now = Date.now()) {
  const snap = snapshotOf(catalog.entries, catalog.sources, catalog.rejected, {
    version: catalog.version,
    now: catalog.generatedAt || now,
    options: pickOptions(options),
  })
  snap.imports = catalog.imports || []
  snap.duplicates = catalog.duplicates || []
  snap.last = loadLast(p)
  // 页面要能回答「现在到底注不注入、注谁、为什么没注」：这里就把答案算好
  const usable = (catalog.entries || []).filter((e) => e.status === 'ok' && e.injectable && typeof e.text === 'string' && e.text.trim())
  // 上游的 state.json 只在用户显式打开 useAgentPurge 时才读：默认不碰别人的目录。
  const state = options.useAgentPurge === true ? readState() : null
  snap.purge = state
    ? { bound: state.bound, mode: state.mode, persona: state.persona, disabled: state.disabled, error: state.error }
    : { bound: false, mode: '', persona: '', disabled: [], error: '' }
  snap.plan = resolvePlan({ options, state, entries: usable })
  return snap
}

function pickOptions(options) {
  const out = {}
  for (const key of ['mode', 'persona', 'agents', 'enabled', 'pinned', 'sources', 'gatewayTimeoutMs', 'useAgentPurge']) {
    if (options?.[key] !== undefined) out[key] = options[key]
  }
  return out
}

/**
 * writeSnapshotIfChanged 写快照，内容没变就不碰文件。
 *
 * 写两份：
 *   page/catalog.json —— 完整快照，含每条目的正文。
 *   page/catalog.js   —— 同一份快照去掉 text，页面用 <script src> 载入。
 *
 * 为什么拆：内置技能是一批红队手册（合计 ~130 KB）。整段内联进 .js 之后，
 * 这个文件就是一个「装着 webshell/Meterpreter/冰蝎 大段文本的可执行脚本」——
 * Defender 据此判过 Trojan:Script/Wacatac.C!ml。正文挪到 .json 就不在脚本引擎里了。
 *
 * 页面能力分两档：
 *   - 只能载 .js 的 CSP（connect-src 'none'）：目录、预算、注入判定全都够用；
 *     正文由 page/hostread.js 请宿主窗口代取（magpie 的 asset 通道）；
 *   - 允许 fetch 自身目录时：页面直接取 .json，不需要绕宿主。
 * 两条都断时页面会说「原文没取到」并给出原因，不再出现点了没反应的按钮。
 *
 * 两件事一起解决：
 *   1. 签名不变时也要让 options/last/plan 的变化落盘（否则页面永远看到第一次的值）；
 *   2. 每次请求都重写两份文件太重，所以先比内容。
 *
 * 写失败不再静默：返回值带着 error，交给调用方上报。
 */
function writeSnapshotIfChanged(p, snapshot) {
  // 去掉正文的那份给页面当脚本用
  const stripped = {
    ...snapshot,
    entries: (snapshot.entries || []).map((e) => (e.text ? { ...e, text: '' } : e)),
  }
  const jsonBody = `${JSON.stringify(snapshot, null, 2)}\n`
  const jsBody = `window.PURGE_CATALOG = ${JSON.stringify(stripped, null, 2)};\n`
  try {
    let changed = false
    for (const [file, body] of [[p.snapshotJsonFile, jsonBody], [p.snapshotFile, jsBody]]) {
      const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
      if (current === body) continue
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, body, 'utf8')
      changed = true
    }
    return { ok: true, changed, error: '' }
  } catch (error) {
    return { ok: false, changed: false, error: error?.message || String(error) }
  }
}

/**
 * applyImports 处理 options.imports 里的请求：复制进 state/imports 或删除副本。
 * 只认白名单后缀，复制前再判一次大小；失败把原因留在结果里，页面显示，不静默吞掉。
 */
export function applyImports(p, imports, previous, now) {
  const done = new Set((previous.imports || []).map((r) => `${r.path}@${r.at}`))
  const rows = Array.isArray(previous.imports) ? previous.imports.filter((r) => r && r.keep) : []
  for (const req of imports) {
    const key = `${req.path}@${req.at}`
    if (done.has(key)) continue
    const op = req.op === 'delete' ? 'delete' : 'import'
    const row = { path: req.path, at: req.at, op, ok: false, error: '', file: '', keep: false }
    try {
      if (op === 'delete') {
        row.ok = removeImport(p, req.path)
        row.error = row.ok ? '' : '没有找到这条导入的副本'
      } else {
        row.file = importFile(p, req.path, req.kind)
        row.ok = Boolean(row.file)
        row.error = row.ok ? '' : `只接受 ${[...IMPORT_EXT].join(' / ')} 文件`
        row.keep = row.ok
      }
    } catch (error) {
      row.error = error?.message || String(error)
    }
    rows.push(row)
  }
  return rows
}

/**
 * importFile 把原件复制进 state/imports。
 *
 * kind 是用户在导入时指定的类型（persona/skill）：写进副本的 frontmatter。
 * 这样类型跟着文件走，不依赖 options 里一份易失的映射；注入时 frontmatter 本来就会被剥掉，
 * 不会混进 system。
 */
function importFile(p, rawPath, kind) {
  const src = String(rawPath).trim()
  if (!src) throw new Error('空路径')
  const ext = extname(src).toLowerCase()
  if (!IMPORT_EXT.has(ext)) return ''
  const st = statSync(src)
  if (!st.isFile()) throw new Error('不是文件')
  if (st.size > LIMITS.fileBytes) throw new Error(`文件超过 ${LIMITS.fileBytes / 1024} KiB 上限`)
  const digest = sha(`${st.size}:${st.mtimeMs}:${src}:${kind || ''}`)
  const target = join(p.importsDir, `${digest}${ext}`)
  if (existsSync(target)) return target
  // 只有 markdown / 文本类才谈得上 frontmatter；zip、json 原样复制。
  const asText = ext === '.md' || ext === '.markdown' || ext === '.txt'
  if (asText && (kind === 'persona' || kind === 'skill')) {
    writeFileSync(target, withKind(readFileSync(src, 'utf8'), kind), 'utf8')
  } else {
    copyFileSync(src, target)
  }
  return target
}

/** withKind 把 kind 写进 frontmatter：已有就替换，没有就补一段。 */
function withKind(raw, kind) {
  const text = String(raw ?? '')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return `---\nkind: ${kind}\n---\n${text}`
  const head = m[1]
  const body = text.slice(m[0].length)
  const next = /^kind\s*:/m.test(head)
    ? head.replace(/^kind\s*:.*$/m, `kind: ${kind}`)
    : `${head}\nkind: ${kind}`
  return `---\n${next}\n---\n${body}`
}

function removeImport(p, rawPath) {
  const base = basename(String(rawPath).trim())
  const target = join(p.importsDir, base)
  if (!existsSync(target)) return false
  if (!readdirSync(p.importsDir).includes(base)) return false
  rmSync(target, { force: true })
  return true
}