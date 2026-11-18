// 破甲 · Purge 的液态玻璃策略（文件很小，但决定整页的底）。
//
// 宿主（magpie 2.4.0 起）把「设置 › 外观」的液态玻璃拆成四个区域，每个区域一对数字：
//   fill：0–100 的不透明度（100 = 实底），blur：0–40 的模糊半径（0 = 不糊）。
// 页面拿到的三样东西见插件仓 docs/developers/liquid-glass-hooks.md：
//   --magpie-glass-<region>-fill / -blur、html[data-magpie-glass]、magpie.glass()/onGlass()。
//
// 为什么页面不直接在 CSS 里读宿主变量、而要过这一层：
//   1. 四个区域是宿主的语义（侧栏 / 主界面 / 浮层 / 控件），本页只有「画布、文字块、浮层、控件」。
//      这里做一次映射，样式里只出现 --purge-glass-*，换映射不用翻整份 CSS。
//   2. 文字块与控件要有**下限**：宿主的数字能拖到 0，但本页的文字是整块铺着的，
//      0% 会把「列表 / 组装 / 导入条」上的字直接扔到壁纸上（违反钩子文档第 3 条硬约束）。
//      画布照抄用户数字（他就是要看壁纸），成块的文字面留 55%，浮层 70%，控件 45%。
//   3. 脏值收敛：少字段、字符串、越界都夹回安全范围，绝不让 NaN 进 CSS 变量
//      （NaN 会让整条声明作废，页面就变成「玻璃一开全白」那种坏法）。
//
// 降级：没有 magpie（直接开页面）、老宿主没玻璃、订阅抛错——一律按「关闭」处理，
// 四个底都是 100%，与没有玻璃的旧版逐像素一致。
;(() => {
  /** REGIONS 是宿主下发的四个区域名；sidebar 本页没有独立导航面，只留作完整性。 */
  const REGIONS = ['sidebar', 'content', 'overlay', 'control']
  /** DEEP_BELOW：主界面不透明度低于这个值，就认为「壁纸真的透进来了」，进 deep 态。 */
  const DEEP_BELOW = 60

  const solid = () => ({ fill: 100, blur: 0 })

  /**
   * num 把宿主给的一个数字夹到 [min, max]。
   *
   * 认数字与「像数字的字符串」（宿主换个版本可能下发 "62"）；其余（null、NaN、'α'）一律回落到
   * fallback。走到 CSS 之前必须是有限数：`62NaN%` 会让整条 background 声明作废。
   */
  function num(value, fallback, min, max) {
    if (value === null || value === undefined || value === '') return fallback
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }

  /**
   * normalize 把宿主那份玻璃数据收成 { on, regions }。
   *
   * 不是对象（老宿主给 null、或页面被单独打开）就返回 null——调用方按「关闭」处理，
   * 不补一套假数字，免得以后排查时分不清「宿主没说」和「宿主说全实底」。
   */
  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const source = value.regions && typeof value.regions === 'object' ? value.regions : {}
    const regions = {}
    for (const name of REGIONS) {
      const part = source[name] && typeof source[name] === 'object' ? source[name] : {}
      regions[name] = {
        fill: num(part.fill, 100, 0, 100),
        blur: num(part.blur, 0, 0, 40),
      }
    }
    // 宿主 pagebridge 目前只下发 sidebar / content / overlay 三个区域（control 还没进去）。
    // 少这一块时，控件跟「主界面」走，而不是退回 100% 实底——否则真机上按钮永远是实心块，
    // 看着跟玻璃没接上一样。
    if (!(source.control && typeof source.control === 'object')) regions.control = { ...regions.content }
    return { on: value.on === true, regions }
  }

  /** levelOf 把玻璃强度收成三档：off（实底）/ lite（轻透）/ deep（壁纸真的透进来了）。 */
  function levelOf(glass) {
    if (!glass || !glass.on) return 'off'
    const values = REGIONS.map((name) => glass.regions[name])
    // on 开着但四个区域都是 100% / 0px：宿主自己的「关闭」坐标，别再让页面挂一层玻璃规则。
    if (values.every((r) => r.fill === 100 && r.blur === 0)) return 'off'
    return glass.regions.content.fill < DEEP_BELOW ? 'deep' : 'lite'
  }

  /**
   * tokensOf 算出页面要写的 CSS 变量。
   *
   * 数字一律照抄宿主，不加下限——这样才跟官方插件页（checkin-relay-probe）同一观感：
   * 「面」用 --card × 主界面数字，胶囊与控件用 --fg 的 10% × 控件数字（乘法在 CSS 里做）。
   * 控件的 blur 不传：宿主自己也只给控件底色与高光边，小方块上糊一层会显脏。
   */
  function tokensOf(glass) {
    const { content, overlay, control } = glass.regions
    return {
      '--purge-glass-canvas-fill': `${content.fill}%`,
      '--purge-glass-canvas-blur': `${content.blur}px`,
      '--purge-glass-ground-fill': `${content.fill}%`,
      '--purge-glass-ground-blur': `${content.blur}px`,
      '--purge-glass-overlay-fill': `${overlay.fill}%`,
      '--purge-glass-overlay-blur': `${overlay.blur}px`,
      '--purge-glass-control-fill': `${control.fill}%`,
      '--purge-glass-control-blur': `${control.blur}px`,
    }
  }

  /**
   * apply 把一份玻璃数据写到文档根上：data-glass 给样式做条件增强，CSS 变量给各层上色。
   *
   * 返回本次的判定，调用方（测试与 attach）不需要再算一遍。
   */
  function apply(root, value) {
    const glass = normalize(value)
    const level = glass ? levelOf(glass) : 'off'
    const tokens = tokensOf(glass || { on: false, regions: Object.fromEntries(REGIONS.map((n) => [n, solid()])) })
    if (root && root.style && typeof root.style.setProperty === 'function') {
      // data-glass 只在浏览器里才有意义：假 root（测试）没有 dataset 也照常返回判定
      if (root.dataset) root.dataset.glass = level
      for (const [name, v] of Object.entries(tokens)) root.style.setProperty(name, v)
    }
    return { level, glass, tokens }
  }

  /**
   * attach 订阅宿主的玻璃变化。
   *
   * 两条来源缺一不可：
   *   - onGlass：玻璃「变化」时宿主会回调（切预设、拖滑块、换深浅色）；
   *   - ready：hello 回来时带着当前的 glass，但宿主不会再补调 onGlass 一次，
   *     所以首屏必须自己从 ready 里捞一次，否则页面要等到用户动一下才生效。
   * 订阅失败、回调抛错都只吞掉这一次：玻璃画不出来是可以接受的，页面挂掉不是。
   */
  function attach(magpie, root) {
    let live = true
    const session = {
      level: 'off',
      settled: Promise.resolve(),
      detach() { live = false },
    }
    const update = (value) => {
      if (!live) return
      try {
        session.level = apply(root, value).level
      } catch { /* 一次写不进去就保持上一次的状态 */ }
    }

    update(magpie && typeof magpie === 'object' ? magpie.glass : null)

    if (magpie && typeof magpie === 'object') {
      if (typeof magpie.onGlass === 'function') {
        try {
          magpie.onGlass((value) => update(value))
        } catch { /* 宿主的订阅坏了，按没有玻璃处理 */ }
      }
      const ready = magpie.ready
      if (ready && typeof ready.then === 'function') {
        session.settled = Promise.resolve(ready)
          .then((theme) => { if (!live) return; if (magpie.glass) return; update(theme && theme.glass) })
          .catch(() => {})
      }
    }
    return session
  }

  globalThis.PurgeGlass = { REGIONS, DEEP_BELOW, normalize, levelOf, tokensOf, apply, attach }

  // 浏览器里自动挂上：页面只加一个 <script>，不必等 app.js 启动。
  // （测试用 Function 跑这份脚本时没有 document，因此不会自动执行。）
  try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.documentElement) {
      attach(window.magpie, document.documentElement)
    }
  } catch { /* 自动挂失败也不该让脚本报错 */ }
})()
