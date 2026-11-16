// 破甲 · Purge 的页面逻辑。
//
// 页面在 magpie 的沙箱帧里：不能 fetch、读不到磁盘，可用的是四样东西——
//   1. window.PURGE_CATALOG：后端扫描后写下的快照（page/catalog.js）；
//   2. magpie.options.get/set：这个插件在 plugins.json 里的设置；
//   3. magpie.ready / onVisibility：主题与可见性；
//   4. page/hostread.js：正文（catalog.json）——页面 fetch 被 CSP 拦时，请宿主窗口代取。
// 所以页面只做「显示 + 改设置」，真正的清点与改写都在 hooks.js 那一侧。
;(() => {
  'use strict'

  const bridge = window.magpie
  const $ = (id) => document.getElementById(id)
  const KINDS = {
    'session-archive': { label: '会话导出包', cls: 'material' },
    'cordis-plugin': { label: 'DSH 插件包', cls: 'material' },
    persona: { label: '人设', cls: 'persona' },
    skill: { label: '技能', cls: 'skill' },
    manifest: { label: '清单', cls: 'material' },
    text: { label: '文本', cls: 'skill' },
  }
  /** 三类语义色：人设 / 技能 / 素材。六种类型各给一色会变成彩虹，信息量却没增加。 */
  const kindClass = (kind) => KINDS[kind]?.cls || 'material'
  /** builtinFolder 从内置条目的 root 里取出它所在的目录名（skills / personas）。 */
  const builtinFolder = (e) => String(e.source?.root || '').split(/[\\/]/).filter(Boolean).pop() || 'skills'
  const MODE_HELP = {
    off: '请求原样放行，什么也不改。',
    strict: '整段可控 system 换成人设；原 system 里的工具说明文本也会一起没了。',
    replace: '人设放最前，宿主 system 里「自称 + 点名模型/厂商」的行删掉。',
    append: '人设放最前，宿主 system 原样保留。',
  }
  /** MODE_SHORT 是下拉里模式名后面那一截：只够一格，别写成整句。 */
  const MODE_SHORT = {
    off: '不动请求',
    strict: '只留人设',
    replace: '去自称',
    append: '原样保留',
  }
  /** NOT_INJECTABLE 只说「它是什么」，下一步交给详情里的 callout，别两处都指路。 */
  const NOT_INJECTABLE = '素材条目：能查看、能归档，但不会写进 system。'

  let options = {}
  let catalog = window.PURGE_CATALOG ?? null
  let selected = ''
  let query = ''
  /** 折起来的分组（按 kind 记）。只存在内存里：这是当次浏览的临时状态，不值得写进 options。 */
  const collapsedGroups = new Set()
  let saveTimer = 0
  let pendingSave = null
  let busy = false
  /** showingText 是「查看原文」的展开态；换条目时要收回去，否则新条目一进来就是展开的。 */
  let showingText = false
  /** textNote 是「正文取不到」时点「查看原文」展开的说明；同样按条目收起。 */
  let textNote = false
  /** editingText 是原文的编辑态；draftText 是编辑中的草稿，点保存才写回 options。 */
  let editingText = false
  let draftText = ''
  /** pendingFile 是「点过选择、还没点导入」的那个文件；两步导入靠它接上。 */
  let pendingFile = null
  /** importKind 是导入时选的类型：auto 交给判定，persona/skill 覆盖它。 */
  let importKind = 'auto'
  /** pendingMode 是「还没开启注入时，下次会用哪个模式」。它只是待选值，不写 options。 */
  let pendingMode = 'replace'
  /** modeMenuOpen 是模式下拉面板是否展开；每次重画都要记住，否则点一下就收。 */
  let modeMenuOpen = false

  // ---------- 小工具 ----------

  const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`)
  const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—')
  const short = (digest) => (digest ? String(digest).slice(0, 12) : '—')

  /**
   * pluginVersion 读插件自己的版本号。
   *
   * 页面拿不到 package.json（沙箱里不能 fetch），但 prepack 会把 app.js 的引用
   * 打上 ?v=<版本号>。从自己的 script 标签把这个参数读回来就行。
   * 开发时是占位的 ?v=0，返回空串，外面显示「开发版」。
   */
  function pluginVersion() {
    const tag = [...document.scripts].find((s) => /(^|\/)app\.js(\?|$)/.test(s.src))
    if (!tag) return ''
    try {
      const v = new URL(tag.src, location.href).searchParams.get('v') || ''
      return v && v !== '0' ? v : ''
    } catch {
      return ''
    }
  }

  function say(text, tone = '') {
    const el = $('status')
    el.textContent = text
    el.dataset.tone = tone
    el.hidden = !text
    if (!text) return
    clearTimeout(say.timer)
    say.timer = setTimeout(() => { el.hidden = true }, 6000)
  }

  /** SVG_NS 是 svg 元素的命名空间：用 createElement 造出来的 <svg> 是 HTML 未知元素，不会渲染。 */
  const SVG_NS = 'http://www.w3.org/2000/svg'

  function el(tag, attrs = {}, ...kids) {
    const node = tag === 'svg' || tag === 'path'
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') node.setAttribute('class', v)
      else if (k === 'text') node.textContent = v
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v === true ? '' : String(v))
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
    }
    return node
  }

  /**
   * bodyText 是「按需取回的正文」缓存。
   *
   * 快照里那份 .js 只有元数据（正文挪去了 catalog.json，见 lib/state.mjs 的注释）。
   * 页面用 page/hostread.js 取一次 .json 把正文补回来：
   *   - 直连 fetch 能过（宿主放开了 connect-src）：直接用；
   *   - 直连被 CSP 拦下：请宿主窗口代取（真机走这条）；
   *   - 两条都断：查看原文仍可点，点开说明原因，不假装成功。
   */
  const bodyText = new Map()
  /** textsState: 'idle' 没试过 / 'loading' 在取 / 'ready' 有正文 / 'blocked' 取不到 */
  let textsState = 'idle'
  let textsError = ''

  // entries 出来就已经套过「改过的正文 / 删掉的条目」：
  // 页面写不了磁盘，编辑与删除只能存 options，由 applyPrefs 统一套用。
  const entries = () => {
    const raw = Array.isArray(catalog?.entries) ? catalog.entries : []
    const api = globalThis.PurgePlan
    const list = api?.applyPrefs ? api.applyPrefs(raw, options) : raw.slice()
    // 正文只从缓存补：快照本身不含它之后，这里是唯一来源
    for (const e of list) {
      if (!e.text && bodyText.has(e.id)) e.text = bodyText.get(e.id)
    }
    return list
  }
  const inlineEntries = () => (Array.isArray(options.inline) ? options.inline : [])

  /**
   * shaped 给「页面导入」的条目补齐其它条目都有的字段。
   *
   * 列表与检查器必须看同一份形状：之前只有列表补了，检查器拿到的是裸对象，
   * 于是 source 缺失 → 认不出是 inline → 不给删除按钮、还把它当素材。
   */
  const shaped = (e) => ({
    ...e,
    status: 'ok',
    reason: '',
    source: { rel: '页面导入（options）', root: 'inline' },
    size: 0,
    meta: { format: 'inline', description: '从「导入」里挑进来的文件，正文存在插件的 options 里。' },
    version: e.version ?? 1,
    importedAt: 0,
    chars: String(e.text || '').length,
    injectable: true,
    builtin: false,
    digest: e.digest || '',
  })

  // findEntry 统一走 shaped：检查器与列表必须看到同一份对象，否则判定会打架。
  const findEntry = (id) =>
    entries().find((e) => e.id === id) ||
    (() => {
      const hit = inlineEntries().find((e) => e.id === id)
      return hit ? shaped(hit) : null
    })()
  const isEnabled = (id) => (options.enabled?.[id] !== undefined ? options.enabled[id] : findEntry(id)?.kind === 'persona')
  /** defaultPersona 是「现在最能顶上的人设」：内置底座优先，其次第一个可用的人设。 */
  const defaultPersona = () =>
    entries().find((e) => e.kind === 'persona' && e.default === true) ||
    entries().find((e) => e.kind === 'persona') ||
    inlineEntries().find((e) => e.kind !== 'skill') ||
    null

  // ---------- 与宿主说话 ----------

  /** save 把整份 options 写回magpie；options.set 每秒只收一次，这里攒 1.1 秒再发。 */
  function save(patch, note) {
    options = { ...options, ...patch }
    if (pendingSave) Object.assign(pendingSave, patch)
    else pendingSave = { ...patch }
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, 1100)
    if (note) say(note)
    render()
  }

  async function flush() {
    if (!pendingSave || !bridge?.options?.set) return
    // 记住这一轮自己刚写下去的键：宿主回包只用来「补全它规范化的字段」，
    // 不许它把我们刚设的值盖回去——否则「选了模式又被换回」会反复发生。
    const sent = { ...(pendingSave || {}) }
    const body = { ...options }
    pendingSave = null
    try {
      const saved = await bridge.options.set(body)
      if (saved && typeof saved === 'object') {
        const merged = { ...body, ...saved }
        for (const key of Object.keys(sent)) merged[key] = body[key]
        options = merged
      }
    } catch (error) {
      say(`保存失败：${error?.message || error}`, 'bad')
    }
  }

  // ---------- 渲染 ----------

  function visible() {
    const q = query.trim().toLowerCase()
    return entries()
      .filter((e) => (q ? `${e.name} ${e.id} ${e.source?.rel ?? ''} ${KINDS[e.kind]?.label ?? ''}`.toLowerCase().includes(q) : true))
      .concat(
        inlineEntries()
          .filter((e) => (q ? `${e.name} ${e.id}`.toLowerCase().includes(q) : true))
          .map(shaped),
      )
  }

  /**
   * focusKind 把列表滚到某一类的分节标题上。
   *
   * 筛选芯片撤掉之后，「去看人设」这类提示按钮不能再用「筛选到只剩人设」——
   * 那样用户会被困在一个只剩一类的列表里。滚过去就够了。
   */
  function focusKind(kind) {
    const head = document.querySelector(`.group-head[data-kind="${kind}"]`)
    if (!head) return
    head.scrollIntoView({ block: 'start', behavior: 'smooth' })
    head.classList.add('is-flash')
    setTimeout(() => head.classList.remove('is-flash'), 900)
  }

  function renderList() {
    const host = $('list')
    const rows = visible()
    if (!hasSnapshot()) {
      // version 0 是「出厂的空壳」：后端还没扫过，或者它根本写不进 page/catalog.js。
      // 这两种情况页面看到的一模一样，所以两句话都要说，别让人猜。
      host.replaceChildren(el('p', { class: 'empty', text: '还没有快照：后端还没扫过，或它写不进 page/catalog.js（插件目录只读时会发生）。点右上角「重新扫描」再等几秒。' }))
      return
    }
    if (!rows.length) {
      host.replaceChildren(el('p', { class: 'empty', text: '没有匹配的条目。清掉搜索，或导入一份文件再来。' }))
      return
    }
    // 按类型分组，取代原来那排筛选芯片：芯片既是筛选器、又兼职「告诉你有几类」，
    // 而类型本来就能靠分节标题说清楚——一条信息两个出口，删掉芯片反而更好读。
    const order = ['persona', 'skill']
    const kinds = [...new Set(rows.map((e) => e.kind))]
    kinds.sort((a, b) => {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    const groups = kinds
      .map((kind) => ({ kind, label: KINDS[kind]?.label || kind, rows: rows.filter((e) => e.kind === kind) }))
      .filter((g) => g.rows.length)

    const nodes = []
    // 算一次「这次由谁顶上」，每行都用它判断人设是否处于启用态。
    // 逐行重算会把 resolve 跑 23 遍，纯属浪费。
    const effectivePersona = currentPlan()?.personaId || ''
    for (const group of groups) {
      // 每一节可以折叠：技能有 23 条时，只想看人设的人不用滚过一整列。
      // 折叠状态记在内存里，重画（点开关、改模式）之后保持原样。
      const det = el('details', { class: 'group', 'data-kind': group.kind })
      det.open = !collapsedGroups.has(group.kind)
      det.append(
        el('summary', { class: 'group-head' },
          el('span', { class: 'group-name', text: group.label }),
          el('span', { class: 'n', text: String(group.rows.length) }),
        ),
        ...group.rows.map((e) => rowOf(e, effectivePersona)),
      )
      det.addEventListener('toggle', () => {
        if (det.open) collapsedGroups.delete(group.kind)
        else collapsedGroups.add(group.kind)
      })
      nodes.push(det)
    }
    // 移除是「从候选里拿掉」，不是删文件；入口留在这儿，否则移掉一条就再也找不回来。
    const removedIds = Object.keys(options.removed || {}).filter((id) => options.removed[id] === true)
    if (removedIds.length) {
      nodes.push(el('div', { class: 'restore-row' },
        el('span', { text: `已移除 ${removedIds.length} 条` }),
        el('button', {
          type: 'button',
          class: 'quiet',
          onclick: () => save({ removed: {} }, `已恢复 ${removedIds.length} 条被移除的条目`),
        }, '全部恢复'),
      ))
    }
    host.replaceChildren(...nodes)
  }

  /**
   * rowOf 画一行条目。
   *
   * 点行本身 = 做它最主要的那件事（技能是开关，人设是设为当前人设）；
   * 点右侧「查看」= 打开检查器看详情与原文。
   * 之前点行是「看详情」，开关另有一片芯片墙——同一件事两个入口，还多占一屏。
   */
  function rowOf(e, effectivePersona = '') {
    const kind = KINDS[e.kind] || { label: e.kind }
    const isPersona = e.kind === 'persona'
    const isCurrent = isPersona && options.persona === e.id
    // 人设的「开」不是 options.enabled，而是「这次到底由谁顶上」：
    // 没显式选人设时，标了 default 的底座人设会被自动选中，它也该显示成已启用。
    // 技能的「开」才是 options.enabled。
    const on = isPersona ? Boolean(effectivePersona) && effectivePersona === e.id : isEnabled(e.id)
    const badge = e.status === 'rejected'
      ? el('span', { class: 'badge reject', text: '拒绝' })
      : !e.injectable
        ? null
        : on ? null : el('span', { class: 'badge off', text: '未启用' })

    const openView = () => {
      // 换条目就收起原文：从一条展开着的详情跳到另一条，不该自动展示别人的正文。
      if (selected !== e.id) { showingText = false; textNote = false }
      selected = selected === e.id ? '' : e.id
      render()
    }

    const act = () => {
      // 素材没有开关可拨，点它就是看详情——总比什么都不发生强。
      if (!e.injectable) return openView()
      if (isPersona) {
        // 人设也是开关：点一下顶上，再点一下停用。
        // 停用时必须同时写 enabled=false——只把 options.persona 清空的话，
        // 「没选人设就自动用底座人设」会把刚关掉的那位又捡回来，看着像点了没反应。
        if (on) {
          const enabledNext = { ...(options.enabled || {}), [e.id]: false }
          save({ persona: '', enabled: enabledNext }, `已停用「${e.name}」：这次不注入人设`)
        } else {
          const enabledNext = { ...(options.enabled || {}), [e.id]: true }
          save({ persona: e.id, enabled: enabledNext }, `已把「${e.name}」设为当前人设`)
        }
      } else {
        save({ enabled: { ...(options.enabled || {}), [e.id]: !on } }, on ? `已停用「${e.name}」` : `已启用「${e.name}」`)
      }
    }

    return el('div', {
      class: `row${on ? ' is-on' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-pressed': on ? 'true' : 'false',
      'aria-selected': selected === e.id,
      title: !e.injectable
        ? '看详情'
        : isPersona
          ? (isCurrent ? '取消当前人设，让回底座人设' : '设为当前人设')
          : (on ? `停用「${e.name}」` : `启用「${e.name}」`),
      onclick: act,
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); act() }
      },
    },
      el('span', { class: 'spine', style: `--spine:var(--kind-${kindClass(e.kind)})` }),
      el('span', {},
        el('span', { class: 'title', text: e.name }),
        // 类型已经不在这里写了：列表按类型分节，每节标题就是类型。
        // 行内只留导入条目的文件名——那是唯一能区分同名条目的信息。
        e.builtin ? null : el('span', { class: 'meta', text: e.source?.rel ?? '' }),
      ),
      // 右侧一列：状态徽标 + 「查看」。徽标原来是跟在名字后面的，
      // 名字长短不一时它左右乱跳；挪到右边固定位置，一列扫下去就能看出谁没启用。
      el('span', { class: 'row-side' },
        badge || null,
        el('button', {
          type: 'button',
          class: 'row-view',
          title: '看详情与原文',
          onclick: (ev) => { ev.stopPropagation(); openView() },
        }, '查看'),
      ),
    )
  }

  /**
   * renderAssembly 是右栏默认内容：把「这次会拼成什么」按顺序摊开。
   *
   * 为什么值得占这一整栏：这个插件的产物就是一段被拼起来的 system 文本，
   * 但它平时在请求里，用户看不见。摊开成积木（人设 → 技能 → 宿主原文），
   * 一眼能看出顺序对不对、谁没启用、总量吃不吃得下预算。
   */
  function renderAssembly() {
    const host = $('assembly')
    const plan = currentPlan()
    const last = catalog?.last
    if (!plan) {
      host.replaceChildren(el('h2', {}, '注入组装'))
      host.append(el('p', { class: 'empty', text: '还没有判定：等后端第一次扫描。' }))
      return
    }
    // 模式是 off 时 plan 里没有内容，右边就成了一个 700px 的空盒子——
    // 而那正是用户最需要「先看看会注什么」的时刻。
    // 这里另算一份「如果开了会怎样」：拿 replace 兜底跑一遍，只用于展示。
    const shown = plan.ready ? plan : previewPlan()
    const personaEntry = findEntry(shown?.personaId)
    const skills = (shown?.skills || []).map((s) => findEntry(s.id) || s)
    const total = (personaEntry?.chars || 0) + skills.reduce((n, s) => n + (s.chars || 0), 0)
    const mode = shown?.mode || plan.mode

    const rows = []
    if (personaEntry) {
      rows.push(stackRow('01', 'persona', personaEntry.name, personaEntry.meta?.description || '人设正文', `${personaEntry.chars || 0} 字`))
      skills.forEach((s, i) => rows.push(stackRow(String(i + 2).padStart(2, '0'), 'skill', s.name, s.meta?.description || '技能正文', `${s.chars || 0} 字`)))
      rows.push(el('div', { class: 'stack-row is-host' },
        el('span', { class: 'ord', text: String(skills.length + 2).padStart(2, '0') }),
        el('span', { class: 'body' },
          el('span', { class: 'name', text: '宿主自己的 system' }),
          el('span', { class: 'desc', text: mode === 'strict' ? 'strict：整段换掉，不会保留' : '原样保留，接在上面这些之后' }),
        ),
        el('span', { class: 'size', text: mode === 'strict' ? '—' : '保留' }),
      ))
    }

    const BUDGET = 65_536
    const sub = !personaEntry
      ? '还没有人设：先挑一条人设'
      : plan.ready ? '下一次请求会拼成这段' : '现在不会注入；下面是开启后会拼成的样子'

    // 合计与「上次生效」都搬到标题行：原来压在清单底下，要和比例尺的数字对上眼
    // 得来回找两次；而底部那块「最近一次生效」折叠区说的也是同一件事。
    // 协议、模式、段数、跳过原因这些细节放 title，鼠标停上去就有，不再单占一块版面。
    const lastText = last?.at
      ? (last.skipped ? `上次 ${fmtTime(last.at)} · 未注入` : `上次 ${fmtTime(last.at)} · ${last.agent || '—'}`)
      : ''
    const lastTitle = last?.at
      ? [
        fmtTime(last.at),
        last.agent || '未知 agent',
        last.protocol || '',
        last.mode || '',
        last.skipped
          ? `未注入：${last.skipped}`
          : `人设 ${last.persona || '（无）'} · 技能 ${(last.skills || []).length} 条 · 注入 ${last.chars} 字符`,
        ...(last.missingPin?.length ? [`固定的版本不在当前表里：${last.missingPin.join('、')}`] : []),
      ].filter(Boolean).join(' · ')
      : ''

    host.replaceChildren(...[
      el('h2', {},
        '注入组装',
        el('span', { class: 'h2-sub', text: sub }),
        lastText ? el('span', { class: 'h2-last', text: lastText, title: lastTitle }) : null,
      ),
      budgetRuler({ personaEntry, skills, total, budget: BUDGET, dim: !plan.ready }),
      el('div', { class: `stack-view${plan.ready ? '' : ' is-preview'}` }, ...rows),
    ].filter(Boolean))
  }

  /**
   * previewPlan 算「如果现在开启注入，会拼成什么」。
   *
   * 只用于展示：模式 off 时 plan 是空的，右边就没东西可看——而那恰好是
   * 用户最需要先看规模的时刻。所以用 replace 兜底跑一遍只为了得到段落构成。
   */
  function previewPlan() {
    const api = globalThis.PurgePlan
    if (!api) return null
    const usable = [...entries(), ...inlineEntries().map(shaped)]
      .filter((e) => e.status === 'ok' && e.injectable)
    const probe = api.resolve({ options: { ...options, mode: 'replace' }, entries: usable })
    return probe.ready ? probe : null
  }

  /**
   * budgetRuler 是这一屏的「仪表」：把 65,536 的预算画成一条横向轨道，
   * 人设与每个技能各占一段按比例的色块。超了就直接越线。
   *
   * 为什么值得当主视觉：这个插件的产物是一段看不见的 system 文本，
   * 用户唯一能判断「够不够、谁最占地方」的依据就是规模。数字并排放在角落
   * 没人会读，画成比例就一眼看得出来。
   */
  function budgetRuler({ personaEntry, skills, total, budget, dim }) {
    const segs = []
    if (personaEntry) segs.push({ cls: 'persona', chars: personaEntry.chars || 0, name: personaEntry.name })
    for (const s of skills) segs.push({ cls: 'skill', chars: s.chars || 0, name: s.name })
    const scale = Math.max(total, budget)
    const over = total > budget
    const pct = (n) => `${Math.max(0, Math.min(100, (n / scale) * 100))}%`

    const track = el('div', { class: `ruler-track${dim ? ' is-dim' : ''}` })
    for (const s of segs) {
      track.append(el('span', {
        class: `ruler-seg is-${s.cls}`,
        style: `width:${pct(s.chars)}`,
        title: `${s.name} · ${s.chars.toLocaleString('zh-CN')} 字符`,
      }))
    }
    // 超出的部分单独一段红色：它已经越过了 65,536 那条线，得能被看见
    if (over) {
      track.append(el('span', { class: 'ruler-seg is-over', style: `width:${pct(total - budget)}`, title: `超出 ${(total - budget).toLocaleString('zh-CN')} 字符` }))
    }

    return el('div', { class: 'ruler', role: 'img', 'aria-label': `预算占用 ${total.toLocaleString('zh-CN')} / ${budget.toLocaleString('zh-CN')} 字符` },
      track,
      // 只有右端一个读数。左端原来写了个「0」标刻度起点，可它既不解释什么，
      // 也不和任何东西对齐——一个孤零零的零，看的人只会问「这 0 是什么意思」。
      el('div', { class: 'ruler-ticks' },
        el('span', {
          class: over ? 'over' : '',
          text: over
            ? `${total.toLocaleString('zh-CN')} / ${budget.toLocaleString('zh-CN')} · 超出 ${(total - budget).toLocaleString('zh-CN')}`
            : `${total.toLocaleString('zh-CN')} / ${budget.toLocaleString('zh-CN')}`,
        }),
      ),
    )
  }

  /** stackRow 是组装里的一层：序号 + 名字 + 一句描述 + 体积。 */
  function stackRow(ord, cls, name, desc, size) {
    return el('div', { class: `stack-row is-${cls}` },
      el('span', { class: 'ord', text: ord }),
      el('span', { class: 'body' },
        el('span', { class: 'name', text: name }),
        el('span', { class: 'desc', text: desc }),
      ),
      el('span', { class: 'size', text: size }),
    )
  }

  function renderInspector() {
    const host = $('inspect')
    const e = findEntry(selected)
    if (!e) {
      // 没选中时让位给「组装预览」：右栏不留一片空白，那是最浪费的一屏。
      showingText = false
      textNote = false
      editingText = false
      host.replaceChildren()
      return
    }
    const kind = KINDS[e.kind] || { label: e.kind }
    const kindCls = kindClass(e.kind)
    const inline = e.source?.root === 'inline' || e.meta?.format === 'inline'
    // 只有复制进插件自己的 state/imports 的副本才谈得上「删副本」：原件不动。
    // root 可能是绝对路径（真机）也可能是相对路径（演示快照），所以不要求前导分隔符。
    const imported = Boolean(e.source?.root && /(^|[\\/])state[\\/]imports\/?$/.test(e.source.root))
    const enabled = isEnabled(e.id)
    const pinned = options.pinned?.[e.id]
    const history = Array.isArray(e.history) ? e.history : []
    // 正文不在 .js 快照里（那是 Defender 判毒的来源），要走宿主通道把 .json 要回来。
    // 取不到就给一个能点的按钮：点开说明原因和文件在哪，绝不留一个点了没反应的死按钮。
    const text = typeof e.text === 'string' ? e.text : ''
    const canShowText = Boolean(text.trim())
    /** stillLoading 是「正文还在路上」：只有这一小段才值得禁用按钮。 */
    const stillLoading = textsState === 'idle' || textsState === 'loading'

    const actions = []
    // 人设才有「设为当前人设」；技能是「启用/停用」。混着写会让人以为技能能当人设用。
    if (e.injectable && e.kind === 'persona') {
      actions.push(el('button', {
        type: 'button',
        class: options.persona === e.id ? 'primary' : '',
        onclick: () => save({ persona: e.id }, `已把「${e.name}」设为当前人设`),
      }, options.persona === e.id ? '当前人设' : '设为当前人设'))
    }
    if (e.injectable) {
      actions.push(el('button', {
        type: 'button',
        onclick: () => save({ enabled: { ...(options.enabled || {}), [e.id]: !enabled } }, enabled ? `已停用「${e.name}」` : `已启用「${e.name}」`),
      }, enabled ? '停用' : '启用'))
    }
    // 「它到底写了什么」是判断要不要启用它的唯一依据：进来就看得到，不用去磁盘翻文件。
    // 正文还在路上时禁用它（并说明在取）；取不到时仍然可点，点开是一段说明而不是沉默。
    if (!canShowText && e.injectable) {
      if (stillLoading) {
        actions.push(el('button', {
          type: 'button',
          disabled: true,
          title: '正在取原文…',
        }, '查看原文'))
      } else {
        actions.push(el('button', {
          type: 'button',
          class: textNote ? 'quiet' : '',
          'aria-expanded': textNote ? 'true' : 'false',
          onclick: () => { textNote = !textNote; editingText = false; renderInspector() },
        }, textNote ? '收起说明' : '查看原文'))
      }
    }
    if (canShowText) {
      actions.push(el('button', {
        type: 'button',
        class: showingText ? 'quiet' : '',
        'aria-expanded': showingText ? 'true' : 'false',
        onclick: () => {
          showingText = !showingText
          editingText = false
          renderInspector()
        },
      }, showingText ? '收起原文' : '查看原文'))
      // 编辑：页面写不了磁盘，改动存进 options.overrides，由网关侧套用。
      // 内置技能在包里，原件不动——所以这里必须说清楚「改的是这个插件里的副本」。
      if (showingText && !editingText) {
        actions.push(el('button', {
          type: 'button',
          onclick: () => {
            editingText = true
            draftText = typeof e.text === 'string' ? e.text : ''
            renderInspector()
          },
        }, '编辑'))
      }
    }
    if (pinned) {
      actions.push(el('button', {
        type: 'button',
        class: 'quiet',
        onclick: () => {
          const next = { ...(options.pinned || {}) }
          delete next[e.id]
          save({ pinned: next }, '已回到最新版本')
        },
      }, '取消版本固定'))
    }
    if (inline) {
      actions.push(el('button', {
        type: 'button',
        class: 'danger',
        onclick: () => {
          // 删掉导入的条目时，指向它的引用也要一起清：否则 plan 会卡在 persona-missing，
          // 用户还得再点一次「改用」才能恢复注入。
          const kept = inlineEntries().filter((x) => x.id !== e.id)
          const enabledNext = { ...(options.enabled || {}) }
          delete enabledNext[e.id]
          const pinnedNext = { ...(options.pinned || {}) }
          delete pinnedNext[e.id]
          const fallback = kept.find((x) => x.kind !== 'skill')
          save({
            inline: kept,
            enabled: enabledNext,
            pinned: pinnedNext,
            persona: options.persona === e.id ? (fallback?.id || '') : options.persona,
          }, `已删除「${e.name}」`)
          if (selected === e.id) selected = ''
          render()
        },
      }, '删除导入'))
      // 类型选错时能就地改：重扫猜出来的类型不一定对，硬编码成「人设」更糟。
      actions.push(el('button', {
        type: 'button',
        class: 'quiet',
        onclick: () => {
          const nextKind = e.kind === 'skill' ? 'persona' : 'skill'
          const next = inlineEntries().map((x) => (x.id === e.id ? { ...x, kind: nextKind } : x))
          save({ inline: next }, `已改判为${nextKind === 'skill' ? '技能' : '人设'}`)
          render()
        },
      }, e.kind === 'skill' ? '改判为人设' : '改判为技能'))
    } else if (imported) {
      actions.push(el('button', {
        type: 'button',
        class: 'danger',
        onclick: () => {
          // 删副本同时把指向它的引用清掉：留着会让 plan 卡在 persona-missing。
          const enabledNext = { ...(options.enabled || {}) }
          delete enabledNext[e.id]
          const pinnedNext = { ...(options.pinned || {}) }
          delete pinnedNext[e.id]
          save({
            enabled: enabledNext,
            pinned: pinnedNext,
            persona: options.persona === e.id ? '' : options.persona,
          })
          importRequest({ op: 'delete', path: e.source.rel }, `已请求删除「${e.name}」的副本（只删插件自己的 state/imports）`)
          if (selected === e.id) selected = ''
        },
      }, '删除副本'))
    } else if (e.builtin) {
      // 内置技能在包里，删不掉文件。这里做的是「从这个插件的候选里拿掉」：
      // 记进 options.removed，列表不再显示、注入也不再带上，可以整批恢复。
      actions.push(el('button', {
        type: 'button',
        class: 'danger',
        title: '从候选里移除（包里的文件不动，可恢复）',
        onclick: () => {
          const enabledNext = { ...(options.enabled || {}) }
          delete enabledNext[e.id]
          const pinnedNext = { ...(options.pinned || {}) }
          delete pinnedNext[e.id]
          const overridesNext = { ...(options.overrides || {}) }
          delete overridesNext[e.id]
          save({
            removed: { ...(options.removed || {}), [e.id]: true },
            enabled: enabledNext,
            pinned: pinnedNext,
            overrides: overridesNext,
            persona: options.persona === e.id ? '' : options.persona,
          }, `已移除「${e.name}」：包里的文件不动，列表底部可恢复`)
          if (selected === e.id) selected = ''
          editingText = false
          render()
        },
      }, '删除'))
    }

    const versionPicker = history.length
      ? el('label', { class: 'note' },
        '回滚到：',
        el('select', {
          onchange: (ev) => {
            const digest = ev.target.value
            const next = { ...(options.pinned || {}) }
            if (digest) next[e.id] = digest
            else delete next[e.id]
            save({ pinned: next }, digest ? '已固定到旧版本' : '已回到最新版本')
          },
        },
          el('option', { value: '', selected: !pinned }, `最新 v${e.version ?? 1}`),
          ...history.map((h) => el('option', { value: h.digest, selected: pinned === h.digest }, `v${h.version ?? '?'} · ${fmtTime(h.at)}`)),
        ),
      )
      : null

    // 详情不再是一张平铺的规格表：主栏说「它是什么、怎么用、占多少」，侧栏放技术事实，
    // 底部单独一条操作栏。原来六行 dl + 一条细预算条全堆在一起，看不出主次。
    const desc = e.meta?.description || (e.injectable ? '可写进 system 段的人设/技能文本。' : NOT_INJECTABLE)
    const pct = Math.min(100, ((e.chars || 0) / 65536) * 100)
    const facts = [
      ['来源', e.source?.root === 'inline' ? '页面导入（存在 options 里）' : e.builtin ? `插件内置 ${builtinFolder(e)}/` : e.source?.root || '—'],
      ['路径', null, 'code', e.source?.rel || '—'],
      ['摘要', null, 'code', short(e.digest)],
      ['版本', `v${e.version ?? 1}${history.length ? ` · 留 ${history.length} 个旧版` : ''}`],
      ['导入', e.builtin ? '随插件' : fmtTime(e.importedAt)],
      ...(e.meta?.sessions !== undefined ? [['会话数', String(e.meta.sessions)]] : []),
      ...(e.meta?.turns !== undefined ? [['选定轮次', String(e.meta.turns)]] : []),
    ]

    // replaceChildren 会把 null 变成 "null" 字符串，所以先过滤。
    host.replaceChildren(...[
      // ---- 头：名字 + 类型 + 一句话定位 ----
      el('header', { class: 'ins-head' },
        el('div', { class: 'ins-title' },
          el('h2', {}, e.name),
          el('span', { class: `kind ${kindCls}` }, kind.label),
          e.builtin ? el('span', { class: 'ins-badge', text: '内置' }) : null,
        ),
        el('p', { class: 'ins-lede', text: desc }),
      ),

      // ---- 主体：主栏（何时用 / 体量）+ 侧栏（技术事实）----
      el('div', { class: 'ins-body' },
        el('div', { class: 'ins-main' },
          e.meta?.whenToUse
            ? el('section', { class: 'ins-callout' },
              el('h3', { text: '何时用' }),
              el('p', { text: e.meta.whenToUse }),
            )
            : null,
          e.injectable
            ? el('section', { class: 'ins-meter' },
              el('h3', {}, '进入 system 的体量',
                el('span', { class: 'ins-pct', text: pct < 1 ? '<1%' : `${pct.toFixed(pct < 10 ? 1 : 0)}%` })),
              el('div', { class: 'meter-track' }, el('div', { class: 'meter-fill', style: `width:${Math.max(pct, 0.6)}%` })),
              el('p', { class: 'ins-meter-note', text: `${(e.chars || 0).toLocaleString('zh-CN')} / 65,536 字符 · 与人设一起拼进 system` }),
            )
            : el('section', { class: 'ins-callout is-material' },
              el('h3', { text: '下一步' }),
              el('p', { text: '把它当资料翻；要注入的话，从「导入与来源」里选一份 .md 人设或技能。' }),
            ),
          // 「出处」比「提炼自」中性：技能是从 dsh-purge 提炼的，人设是新写的，一个前缀套不住两种。
          e.builtin && e.meta?.source
            ? el('p', { class: 'ins-origin', text: `出处：${e.meta.source}` })
            : null,
        ),
        el('aside', { class: 'ins-facts' },
          ...facts.flatMap(([k, v, tag, code]) => [
            el('dt', { text: k }),
            el('dd', {}, v !== null ? String(v) : el(tag || 'code', { text: code })),
          ]),
        ),
      ),

      // ---- 底：操作栏 ----
      actions.length
        ? el('footer', { class: 'ins-actions' }, ...actions)
        : null,
      versionPicker,
      pinned ? el('p', { class: 'note', text: `当前固定到 ${short(pinned)}：网关用那一版的正文，不是最新的。` }) : null,
      // 原文按注入形态显示：前面出现的技能段，正文会以「## 技能：<名字>」为界拼进去。
      showingText && canShowText
        ? (editingText ? textEditor(e) : el('pre', { class: 'text', text: text.length > 8000 ? `${text.slice(0, 8000)}\n…（共 ${text.length.toLocaleString('zh-CN')} 字符，后面省略）` : text }))
        : null,
      // 正文没取到时的说明：给出真正的原因和文件位置，让用户知道下一步去哪看。
      textNote && !canShowText
        ? el('section', { class: 'ins-callout is-material' },
          el('h3', { text: '原文没取到' }),
          el('p', { text: textsError || '宿主没有把正文交给页面。' }),
          el('p', { class: 'note', text: `文件在：${e.source?.root === 'inline' ? '页面导入（存在 options 里，可点「编辑」看）' : (e.builtin ? `${builtinFolder(e)}/${e.source?.rel || ''}` : (e.source?.rel || '（快照里没有路径）'))}` }),
        )
        : null,
    ].filter(Boolean))
  }

  /**
   * textEditor 是原文的编辑态。
   *
   * 存进 options.overrides[id]，不碰磁盘：内置技能在包里改不动，
   * state/imports 归后端管。网关侧用 lib/plan.mjs 的 applyPrefs 套用同一份覆盖。
   */
  function textEditor(e) {
    const area = el('textarea', {
      class: 'text-edit',
      spellcheck: 'false',
      rows: '18',
      oninput: (ev) => { draftText = ev.target.value },
    })
    area.value = draftText

    const inlineNow = e.source?.root === 'inline'
    const saveDraft = () => {
      const next = area.value
      if (!next.trim()) { say('正文不能为空：要拿掉这条请用「删除」', 'bad'); return }
      if (inlineNow) {
        // 页面导入的条目正文本来就存在 options.inline 里，直接写回它自己
        const list = inlineEntries().map((x) => (x.id === e.id ? { ...x, text: next } : x))
        save({ inline: list }, `已保存「${e.name}」的正文`)
      } else {
        save({ overrides: { ...(options.overrides || {}), [e.id]: next } }, `已保存「${e.name}」的正文（原件不动）`)
      }
      editingText = false
      render()
    }

    return el('div', { class: 'text-wrap' },
      el('div', { class: 'text-bar' },
        el('span', { class: 'note', text: `${String(area.value || '').length.toLocaleString('zh-CN')} 字符` }),
        el('button', {
          type: 'button',
          class: 'quiet',
          onclick: () => {
            // 恢复成原件正文：有覆盖就删掉，没覆盖就重新拉一次快照里的 text
            if (inlineNow) { say('页面导入的条目没有「原件」可回退：改坏了就重新导入一份', 'bad'); return }
            const next = { ...(options.overrides || {}) }
            delete next[e.id]
            save({ overrides: next }, `已把「${e.name}」恢复成原件正文`)
            editingText = false
            render()
          },
        }, '还原'),
        el('button', { type: 'button', onclick: () => { editingText = false; renderInspector() } }, '取消'),
        el('button', { type: 'button', class: 'primary', onclick: saveDraft }, '保存'),
      ),
      area,
      el('p', { class: 'note', text: '改的是这个插件里的副本：包里的 .md 文件不动，网关注入时用你保存的这份。' }),
    )
  }

  function renderRejects() {
    const host = $('rejects')
    const rows = Array.isArray(catalog?.rejected) ? catalog.rejected : []
    const badge = $('rejects-count')
    if (badge) badge.textContent = rows.length ? `${rows.length}` : ''
    // 没有拒绝项就整块收起来：平时它只是一行「都认得出来」，白占底部一条。
    // 真出问题时才出现，并且带数量。
    const fold = $('rejects-fold')
    if (fold) fold.hidden = rows.length === 0
    if (!rows.length) {
      host.replaceChildren()
      return
    }
    host.replaceChildren(...rows.slice(0, 24).map((r) => el('li', {}, el('strong', { text: r.name }), `：${r.reason}`)))
  }

  function render() {
    if (!catalog) {
      $('count').textContent = '没有快照'
    } else {
      const shown = visible().length
      // 显示插件版本而不是「快照 v12」：那个数字是后端的扫描计数，
      // 对用户没有意义；版本号才回答「我装的是哪一版」。
      const ver = pluginVersion()
      const verText = ver ? `v${ver.replace(/^v/, '')}` : '开发版'
      $('count').textContent = `${shown} / ${entries().length + inlineEntries().length} 条 · ${verText} · ${fmtTime(catalog.generatedAt)}`
    }
    renderPlan()
    renderList()
    // 选着条目就看详情，没选就回组装预览：右栏永远有东西，不留空屏。
    renderAssembly()
    renderInspector()
    // 详情在浮层里，右栏永远是「注入组装」：以前详情顶掉右栏，
    // 想对标一下组装就得先关掉详情，来回切。
    const picked = Boolean(findEntry(selected))
    $('modal').hidden = !picked
    renderRejects()
  }

  /** MODES 是模式下拉的全部取值：没有「跟随上游」这一档，模式必须自己选。 */
  /**
   * MODES 是模式下拉的全部取值。
   *
   * 没有 off：关掉注入由右侧那颗开关负责，不再混进下拉里。
   * 「选模式」和「开不开」是两件事——混在一起时，用户要关掉注入得先学会
   * 在下拉里挑一个叫 off 的东西，那不像个开关。
   */
  const MODES = () => ['strict', 'replace', 'append']
  /** injecting 判断现在是不是真的在注入：mode 落在三种改写模式之一才算。 */
  const injecting = () => MODES().includes(options.mode)

  /** modeHelp 说清当前值到底意味着什么；未选时说清未选就是不动请求。 */
  function modeHelp(value) {
    if (value) return MODE_HELP[value] || ''
    return '还没选模式：请求原样放行。选一个（比如 replace）才开始注入。'
  }

  /**
   * planStale 判断「快照里的判定」是否已经跟不上本地设置了。
   *
   * 只比这两件会直接改变结论的事：模式与生效的人设。比完就知道该不该按旧结论劝人。
   */
  function planStale(plan) {
    if (!plan) return false
    const localMode = MODES().includes(options.mode) ? options.mode : ''
    if (localMode && localMode !== plan.mode) return true
    const localPersona = typeof options.persona === 'string' ? options.persona.trim() : ''
    if (localPersona && localPersona !== plan.personaId) return true
    return false
  }

  /**
   * currentPlan 是「现在这套设置会让网关怎么做」。
   *
   * 优先本地算：后端只在有请求经过时才重扫写快照，不动 agent 的话快照永远旧，
   * 技能开关、装配面板、状态条就全都停在改之前的样子。
   * 只有 useAgentPurge 打开时才不得不用快照——state.json 只有后端读得到。
   */
  function currentPlan() {
    if (options.useAgentPurge === true) return catalog?.plan || null
    const api = globalThis.PurgePlan
    if (!api) return catalog?.plan || null
    const usable = [...entries(), ...inlineEntries().map(shaped)]
      .filter((e) => e.status === 'ok' && e.injectable)
    return api.resolve({ options, entries: usable })
  }

  /**
   * renderPlan 是「现在到底注不注、注谁、为什么没注」那一行。
   *
   * 判定用 currentPlan()：本地算，所以改完设置立刻反映，不用等后端重扫。
   * 快照里的 plan 只在 useAgentPurge 打开时才用得上（state.json 只有后端读得到）。
   */
  function renderPlan() {
    const host = $('plan')
    // 模式是从外面改的（比如用户手改 plugins.json、或别的入口写了 mode）：
    // 把待选值跟上，否则下拉会一直显示旧的待选模式。
    if (injecting()) pendingMode = options.mode
    const plan = currentPlan()
    if (!plan) {
      host.dataset.state = 'idle'
      host.replaceChildren(
        el('span', { class: 'dot' }),
        el('span', { class: 'empty', text: '还没有判定：等后端第一次扫描' }),
      )
      return
    }
    const ready = Boolean(plan.ready)
    // 判定已经是本地的了，正常情况下不会过期；留这条只在 useAgentPurge 模式下生效，
    // 那种模式页面算不了，只能拿快照，仍可能出现「刚改完还没重扫」的短暂不一致。
    const stale = planStale(plan)
    // personaFrom 的三种来源，用户一眼要能看懂「谁在顶着」：
    //   page = 自己点的、auto = 底座人设自动顶上、default = agent-purge（仅在显式开启时）
    const fromText = { page: '本页设置', auto: '底座人设（没选人设时自动顶上）', default: '默认' }
    host.dataset.state = ready ? 'ready' : 'blocked'

    // 没就绪时给一个能点的下一步：光说「不会注入」等于把问题丢回给人。
    // 每个按钮都顺带 refreshAt：宿主重建插件进程后按新设置重扫，plan 才会跟着变。
    const fix = []
    const fixed = (patch, note) => {
      save({ ...patch, refreshAt: Date.now() }, note)
      pollSnapshot('等后端按新设置重扫…', 25)
    }
    // 不再有「用 replace 开始注入」这个补救按钮：右侧那颗开关就是干这个的，
    // 同样的动作摆两处只会让人犹豫点哪个。
    if (!ready) {
      // 旧人设被删掉后 options.persona 会一直指着它，卡在 persona-missing：
      // 这个问题点「去看人设」永远绕不出来，得给一个直接改掉它的动作。
      if (plan.blockedCode === 'persona-missing' && defaultPersona()) {
        const next = defaultPersona()
        fix.push(el('button', {
          type: 'button',
          class: 'primary',
          onclick: () => fixed({ persona: next.id }, `人设改为「${next.name}」`),
        }, `改用「${next.name}」`))
      }
      if (!stale && (plan.blockedCode === 'no-persona' || plan.blockedCode === 'persona-missing')) {
        fix.push(el('button', {
          type: 'button',
          onclick: () => focusKind('persona'),
        }, '去看人设'))
      }
      if (!stale && plan.blockedCode === 'no-persona-file') {
        fix.push(el('button', {
          type: 'button',
          class: 'primary',
          onclick: () => {
            // 没有人设文件时，列表里连「人设」这一节都没有，滚不过去；
            // 打开导入区才是能解决问题的那一步。
            const fold = $('import-fold')
            if (fold) { fold.open = true; fold.scrollIntoView({ block: 'nearest' }) }
          },
        }, '导入一份人设'))
      }
    }

    // 两行文字放进同一列：第一行是结论，第二行是依据；右边的胶囊组跨两行垂直居中。
    // 原来「为什么」那行缩进 20px，看起来像挂件；现在两行左对齐，读起来是一段话。
    // 过期时不复述旧结论：直接说「等重扫」，免得左边写 append、右边说「还没选模式」。
    const who = stale
      ? '设置已改，等后端重扫确认'
      : ready
        ? `下一次 agent 请求会注入「${plan.personaName || plan.personaId}」`
        : '现在不会注入：请求原样放行'
    const why = stale
      ? '刚改完模式或人设：下一次请求按新设置走，这里显示的是上一次扫描的判定'
      : ready
        ? `人设来源：${fromText[plan.personaFrom] || plan.personaFrom}`
        : plan.blocked

    const rows = [
      el('span', { class: 'dot' }),
      el('span', { class: 'plan-text' },
        el('span', { class: ready && !stale ? 'who' : 'who is-empty' }, who),
        el('span', { class: 'why', text: why }),
      ),
      el('span', { class: 'plan-controls' },
        modePill(),
        ...fix,
        // 开关永远在场：关掉注入不需要「先满足条件」，随时都能关。
        injectToggle(plan),
      ),
      // 面板浮在胶囊组下面：.plan-controls 要 overflow:hidden 才能把两段裁成一颗胶囊，
      // 所以面板不能放在它里面，只能挂在 .plan 上做绝对定位。
      modeMenuOpen ? modeMenu() : null,
    ]
    host.replaceChildren(...rows.filter(Boolean))
  }

  /**
   * modePill 是胶囊组的第一段：模式选择器。
   *
   * 不用原生 select：系统的下拉面板是浏览器自己画的，颜色、圆角、间距全都改不了，
   * 深色主题下还会弹出一块浅色板。这里自绘：按钮 + 自绘面板，
   * 键盘（上下键 / Esc / Enter）与 aria 都按 listbox 的模式接好。
   */
  function modePill() {
    const live = injecting()
    // 没开启注入时显示「下次会用哪个模式」，它只是待选值，还没写进 options。
    const value = live ? options.mode : pendingMode
    const label = `${value} · ${MODE_SHORT[value] || ''}`
    return el('button', {
      type: 'button',
      class: `seg seg-mode${live ? ' is-locked' : ''}`,
      title: live ? '注入已开启：先关掉右侧的开关才能换模式' : modeHelp(value),
      'aria-haspopup': 'listbox',
      'aria-expanded': modeMenuOpen ? 'true' : 'false',
      'aria-disabled': live ? 'true' : 'false',
      onclick: (e) => {
        e.stopPropagation()
        // 开启注入期间锁住模式：改模式等于换一套改写规则，
        // 而请求随时可能进来——必须先把注入关掉，改完再开。
        if (live) { say('注入开着的时候不能换模式：先点右边的「已注入」关掉它', 'bad'); return }
        modeMenuOpen = !modeMenuOpen
        renderPlan()
        if (modeMenuOpen) document.querySelector('.seg-opt.is-on')?.focus()
      },
      onkeydown: (e) => {
        if (live) return
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          modeMenuOpen = true
          renderPlan()
          document.querySelector('.seg-opt.is-on')?.focus()
        }
      },
    },
      el('span', { class: 'seg-key', text: '模式' }),
      el('span', { class: 'seg-value', text: label }),
      el('svg', { class: 'seg-chev', viewBox: '0 0 12 12', 'aria-hidden': 'true' },
        el('path', { d: 'M2.5 4.5 L6 8 L9.5 4.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      ),
    )
  }

  /** modeMenu 是自绘的下拉面板：每项两行——模式名 + 一句它到底干什么。 */
  function modeMenu() {
    const value = injecting() ? options.mode : pendingMode
    const pick = (m) => {
      modeMenuOpen = false
      // 只记住待选值，不写 options：写进去就等于开始注入了，
      // 而「什么时候开始」由右侧那颗开关决定。
      pendingMode = m
      renderPlan()
    }
    const move = (delta) => {
      const opts = [...document.querySelectorAll('.seg-opt')]
      const i = opts.indexOf(document.activeElement)
      const next = opts[Math.min(opts.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))]
      next?.focus()
    }
    return el('div', {
      class: 'seg-menu',
      role: 'listbox',
      'aria-label': '改写模式',
      onclick: (e) => e.stopPropagation(),
      onkeydown: (e) => {
        if (e.key === 'Escape') { modeMenuOpen = false; renderPlan(); return }
        if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
        if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
      },
    },
      ...MODES().map((m) => el('button', {
        type: 'button',
        class: `seg-opt${m === value ? ' is-on' : ''}`,
        role: 'option',
        'aria-selected': m === value ? 'true' : 'false',
        tabindex: m === value ? '0' : '-1',
        onclick: () => pick(m),
      },
        el('span', { class: 'seg-opt-body' },
          el('span', { class: 'seg-opt-name', text: m }),
          el('span', { class: 'seg-opt-sub', text: MODE_HELP[m] }),
        ),
        m === value
          ? el('svg', { class: 'seg-check', viewBox: '0 0 12 12', 'aria-hidden': 'true' },
            el('path', { d: 'M2.5 6.2 L5 8.6 L9.5 3.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
          : null,
      )),
    )
  }

  /**
   * injectToggle 是右侧那颗开关：「开始注入」/「已注入」。
   *
   * 它管「开不开」，模式下拉管「怎么改」。以前这里只是打个本地勾，
   * 关掉注入还得去下拉里挑一个叫 off 的东西——两件相反的事绕在两个地方。
   * 现在点「已注入」就是关掉（mode 清空），模式下拉随之解锁。
   */
  function injectToggle(plan) {
    const live = injecting()
    const persona = (typeof options.persona === 'string' && options.persona.trim()) || plan.personaId || ''
    // 证据只用来写 title：最近一次后端真的改过，且用的就是现在这套
    const last = catalog?.last
    const evidence = Boolean(live && last && !last.skipped && last.mode === options.mode && (last.persona || '') === persona)

    return el('button', {
      type: 'button',
      class: `seg seg-action${live ? ' is-applied' : ' is-armed'}`,
      'aria-pressed': live ? 'true' : 'false',
      title: live
        ? `已开启注入（${options.mode}）${evidence ? `；最近一次生效 ${fmtTime(last.at)}` : ''}。点一下关掉，之后请求原样放行`
        : `按 ${pendingMode} 开始注入。开启后模式会锁定，要换模式得先关掉`,
      onclick: () => {
        if (live) {
          save({ mode: '' }, `已关闭注入：请求原样放行（记住的模式是 ${pendingMode}）`)
          return
        }
        save({ mode: pendingMode }, `已开始注入：模式 ${pendingMode}`)
        refresh()
      },
    }, live ? '已注入' : '开始注入')
  }

  // ---------- 动作 ----------

  function importRequest(req, note) {
    const imports = Array.isArray(options.imports) ? options.imports.slice(-19) : []
    imports.push({ ...req, at: Date.now() })
    save({ imports, refreshAt: Date.now() }, note)
    pollSnapshot(`等待后端处理：${req.path}`, 25)
  }

  /** pollSnapshot 每隔 1.2 秒重新加载 catalog.js（加时间戳绕缓存），版本变了就重画。 */
  function pollSnapshot(reason, seconds = 12) {
    const before = catalog?.version ?? 0
    const until = Date.now() + seconds * 1000
    say(reason)
    const tick = () => {
      const script = document.createElement('script')
      script.src = `catalog.js?t=${Date.now()}`
      script.onload = () => {
        script.remove()
        const next = window.PURGE_CATALOG
        if (next && next.version !== before) {
          catalog = next
          render()
          // 新快照的 .js 里依然没有正文，重新取一次 .json
          textsState = 'idle'
          loadTexts()
          say('快照已更新', 'good')
          return
        }
        if (Date.now() < until) setTimeout(tick, 1200)
        else say('后端还没写出新快照：magpie 里插件可能没重启，或它写不进 page/catalog.js（插件目录只读）。', 'bad')
      }
      script.onerror = () => {
        script.remove()
        if (Date.now() < until) setTimeout(tick, 1200)
      }
      document.head.append(script)
    }
    setTimeout(tick, 900)
  }

  async function refresh() {
    if (busy) return
    busy = true
    try {
      save({ refreshAt: Date.now() })
      await flush()
      pollSnapshot('正在让后端重新扫描…', 25)
    } finally {
      busy = false
    }
  }

  /** closeModal 关掉详情浮层：把选中项清掉，下一次 render 就不会再画它。 */
  function closeModal() {
    if (!selected) return
    selected = ''
    showingText = false
    textNote = false
    editingText = false
    render()
    // 焦点还给列表，别掉到 body 上让键盘用户迷路
    document.querySelector('#list .row')?.focus()
  }

  function wire() {
    // 模式选择器与「确认注入」都是每次 renderPlan 重建的，监听写在创建处（onclick/onkeydown），
    // 这里只绑那些常驻不动的控件。
    $('q').addEventListener('input', (e) => { query = e.target.value; render() })

    // 详情浮层：右上角 ×、点空白处、按 Esc 都能关。
    $('modal-close').addEventListener('click', closeModal)
    $('modal').addEventListener('click', (e) => {
      // 只有点在遮罩本身（不是卡片内部）才关
      if (e.target === $('modal')) closeModal()
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('modal').hidden) { e.stopPropagation(); closeModal() }
    })

    // 点面板以外的地方就收起。用捕获阶段：面板内部自己 stopPropagation。
    document.addEventListener('click', () => {
      if (!modeMenuOpen) return
      modeMenuOpen = false
      renderPlan()
    })

    // 导入分两步：先选文件（把路径填进输入框），再点「导入」才真的导入。
    // 一步到底容易误触：浏览器选完就导入，用户还没确认类型就落盘了。
    $('import-pick').addEventListener('click', () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.md,.markdown,.txt,.json,.zip'
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        if (!file) return
        // 浏览器出于安全不暴露真实路径，只能拿到文件名。
        // 这一步先把名字填进去，让人看见选中了什么；真正导入走下面那条 inline 通道。
        $('import-path').value = file.name
        pendingFile = file
        say(`已选中「${file.name}」，再点一次「导入」就写入`, 'good')
      })
      input.click()
    })

    $('import-run').addEventListener('click', async () => {
      const typed = $('import-path').value.trim()
      // 手填的是绝对路径：交给后端复制（原文件不动，副本进 state/imports）。
      if (typed && !pendingFile) {
        importRequest({ op: 'import', path: typed, kind: importKind }, '已请求导入')
        $('import-path').value = ''
        return
      }
      const file = pendingFile
      if (!file) return say('先点「选择」挑一个文件，或在框里填绝对路径', 'bad')
      try {
        const raw = await file.text()
        if (raw.length > 64 * 1024) throw new Error('超过 64 KB：这么大的正文不该塞进 options')
        const id = (file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'inline').slice(0, 48)
        const kept = inlineEntries().filter((x) => x.id !== id)
        const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        const declared = fm?.[1]?.match(/^kind:\s*(persona|skill)\s*$/m)?.[1]
        const name = fm?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') || file.name.replace(/\.[^.]+$/, '')
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
        // 类型的优先级：用户明确选的 > 文件自己写的 > 猜。
        const kind = importKind !== 'auto' ? importKind : declared || guessKind(body)
        save({ inline: [...kept, { id, name, kind, text: body }] }, `已导入「${name}」（${kind === 'skill' ? '技能' : '人设'}）`)
        pendingFile = null
        $('import-path').value = ''
        refreshAfterImport()
      } catch (error) {
        say(`导入失败：${error?.message || error}`, 'bad')
      }
    })

    // 导入类型：三选一，选中项自己管自己的 aria-pressed。
    for (const chip of document.querySelectorAll('#import-kind .chip')) {
      chip.addEventListener('click', () => {
        importKind = chip.dataset.kind || 'auto'
        for (const other of document.querySelectorAll('#import-kind .chip')) {
          other.setAttribute('aria-pressed', other === chip ? 'true' : 'false')
        }
      })
    }
  }

  /**
   * guessKind 猜一份 .md 是人设还是技能。
   *
   * 判据来自本插件自己的两种文件长相：人设是完整第二人称，通常带 `## 你是什么`／`你是谁`；
   * 技能是「某个领域的专家」，标题一般是 `# X专家`，正文多含命令与表格。
   */
  function guessKind(body) {
    const text = String(body || '')
    if (/^##\s*(你是什么|你是谁|你是谁？)/m.test(text)) return 'persona'
    if (/^(你是|你现在是)/m.test(text) && !/^#\s/m.test(text)) return 'persona'
    if (/^#\s/m.test(text) && /(\||命令|工具|参数)/.test(text)) return 'skill'
    return 'persona'
  }

  /** refreshAfterImport 让新导入的条目立刻出现在列表里，并让后端按新 options 重扫。 */
  function refreshAfterImport() {
    save({ refreshAt: Date.now() })
    render()
    pollSnapshot('等后端按新导入重扫…', 20)
  }

  async function boot() {
    // 先自己拉一份快照，带上时间戳。
    // 静态 <script src="catalog.js"> 没有任何版本参数：更新插件后浏览器可能一直用旧缓存，
    // 于是「怎么更新看到的都是老快照」。这里改成每次进页面都重新取一次。
    await loadSnapshot()
    if (bridge?.ready?.then) {
      try {
        await Promise.race([bridge.ready, new Promise((r) => setTimeout(r, 1500))])
      } catch {
        /* 宿主没答也要能画 */
      }
    }
    if (bridge?.onVisibility) bridge.onVisibility((visible) => { if (visible && !busy) refreshFromDisk() })
    try {
      options = (await bridge?.options?.get?.()) || {}
    } catch (error) {
      say(`读不到 options：${error?.message || error}`, 'bad')
      options = {}
    }
    wire()
    render()
    // 预览用：?menu=1 直接把下拉面板展开，省得截图时还要模拟点击。
    if (new URLSearchParams(location.search).get('menu') === '1') {
      modeMenuOpen = true
      renderPlan()
    }
    // 包内 catalog.js 出厂是个空壳（version: 0）。它是个真值对象，所以
    // `if (!catalog)` 永远不成立——新装用户会对着空列表干等，页面不会自己重试。
    // 判据要落到版本号上：version < 1 就是「后端还没扫过」。
    if (!hasSnapshot()) pollSnapshot('等后端第一次扫描…', 25)
    else loadTexts()
  }

  /**
   * loadTexts 把正文从 catalog.json 取回来。
   *
   * 快照的 .js 只有元数据：内置技能是一批红队手册，整段内联进脚本会被
   * Defender 判成 Trojan:Script/Wacatac.C!ml。正文单独写成 .json，
   * 页面通过 page/hostread.js 取：先直连 fetch，被 CSP（connect-src 'none'）
   * 拦下就让宿主窗口代取——那条通道是 magpie 自己给页面取页内文件用的。
   */
  async function loadTexts() {
    if (textsState === 'loading' || textsState === 'ready') return
    if (window.__PURGE_SINGLE_FILE__) {
      // 单文件预览把完整快照内联在 <script type="application/json"> 里
      const node = document.getElementById('snapshot-json')
      if (node) {
        try {
          applyTexts(JSON.parse(node.textContent || '{}'))
          return
        } catch { /* 落到下面按取不到处理 */ }
      }
      textsState = 'blocked'
      textsError = '单文件预览不带正文：它只用于看界面；真机里正文由宿主窗口代取'
      return
    }
    textsState = 'loading'
    try {
      const read = globalThis.PurgeHostRead?.readText
      if (typeof read !== 'function') throw new Error('页面缺少读通道：page/hostread.js 没加载')
      const body = await read(`catalog.json?t=${Date.now()}`)
      applyTexts(JSON.parse(body))
    } catch (error) {
      // 两条通道都断时 hostread.js 会把两个原因一起报出来，这里原样留给用户看。
      textsState = 'blocked'
      textsError = String(error?.message || error)
      renderInspector()
    }
  }

  /** applyTexts 把完整快照里的正文灌进缓存，然后重画一次。 */
  function applyTexts(full) {
    for (const e of full?.entries || []) {
      if (typeof e?.text === 'string' && e.text.trim()) bodyText.set(e.id, e.text)
    }
    textsState = bodyText.size ? 'ready' : 'blocked'
    if (!bodyText.size) textsError = '正文不落盘：注入时才从原文件读，页面这一份只有元数据'
    render()
    if (selected) renderInspector()
  }

  /** hasSnapshot 判断手上的快照是不是「真的扫过」——空壳（version 0）不算。 */
  function hasSnapshot() {
    return Boolean(catalog && Number(catalog.version) >= 1 && Array.isArray(catalog.entries))
  }

  /** loadSnapshot 动态取最新快照脚本；失败就当没有，别让启动挂住。 */
  function loadSnapshot() {
    return new Promise((resolve) => {
      // 单文件预览把快照内联了，没有 catalog.js 可取
      if (window.__PURGE_SINGLE_FILE__) { resolve(); return }
      const script = document.createElement('script')
      script.src = `catalog.js?t=${Date.now()}`
      script.onload = () => {
        script.remove()
        if (window.PURGE_CATALOG) catalog = window.PURGE_CATALOG
        resolve()
      }
      script.onerror = () => { script.remove(); resolve() }
      document.head.append(script)
    })
  }

  /** 页面被切回来时顺手换一份快照：宿主可能在背后扫过一次。 */
  function refreshFromDisk() {
    const script = document.createElement('script')
    script.src = `catalog.js?t=${Date.now()}`
    script.onload = () => {
      script.remove()
      const next = window.PURGE_CATALOG
      if (next && next.version !== catalog?.version) {
        catalog = next
        render()
        textsState = 'idle'
        loadTexts()
      }
    }
    script.onerror = () => script.remove()
    document.head.append(script)
  }

  boot()
})()