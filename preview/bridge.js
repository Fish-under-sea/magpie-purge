// mock 的 magpie 页面桥（真品是 magpie 的 internal/gui/pagebridge.js）。
// 只实现插件页用到的那几样：ready / theme / glass / options.get/set / onVisibility。
// 主题走 URL 参数：?theme=dark|light，默认 dark；玻璃走 ?glass=off|lite|balanced|clear。
;(() => {
  const q = new URLSearchParams(location.search)
  const dark = (q.get('theme') || 'dark') !== 'light'
  const tokens = dark
    ? {
        bg: '#15171c', fg: '#e6e7ea', muted: '#8d93a0', card: '#1c1f26', line: '#2c313b',
        accent: '#7c8cff', 'accent-soft': '#232844', code: '#a9b1c6',
        font: '-apple-system, "Segoe UI", "Noto Sans SC", system-ui, sans-serif',
      }
    : {
        bg: '#fbfbf9', fg: '#1c1d21', muted: '#6b7280', card: '#ffffff', line: '#e3e3e6',
        accent: '#3563e9', 'accent-soft': '#e6edfd', code: '#4b5162',
        font: '-apple-system, "Segoe UI", "Noto Sans SC", system-ui, sans-serif',
      }

  /**
   * GLASS 是预览用的四套数字，形状与真机一致：每个区域 [fill 百分比, blur px]。
   *
   * 真机上这些值来自「设置 › 外观」的滑块，页面只管读；预览里必须能手动摆到几档，
   * 否则玻璃相关的回归（文字透没透、高光边还在不在）只能靠装进 magpie 手点。
   * 数字照 2.4.4 的常见配置取：侧栏 82/12、浮层 86/10、控件 92/8。
   */
  const GLASS = {
    off: { sidebar: [82, 12], content: [100, 0], overlay: [100, 0], control: [100, 0] },
    lite: { sidebar: [82, 12], content: [82, 12], overlay: [86, 10], control: [92, 8] },
    balanced: { sidebar: [82, 12], content: [62, 26], overlay: [86, 10], control: [92, 8] },
    clear: { sidebar: [82, 12], content: [20, 30], overlay: [55, 16], control: [40, 8] },
  }
  const glassName = Object.hasOwn(GLASS, q.get('glass')) ? q.get('glass') : 'off'
  const regions = Object.fromEntries(
    Object.entries(GLASS[glassName]).map(([name, [fill, blur]]) => [name, { fill, blur }]),
  )
  const glass = { on: glassName !== 'off', regions }

  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.colorScheme = dark ? 'dark' : 'light'
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty('--magpie-' + k, v)

  // 与真机 pagebridge.js 的 paint() 同形：属性表示「有没有区域真透」，变量给四个区域各一对数字。
  const paintGlass = () => {
    root.toggleAttribute('data-magpie-glass', glass.on)
    for (const [name, part] of Object.entries(regions)) {
      root.style.setProperty(`--magpie-glass-${name}-fill`, `${part.fill}%`)
      root.style.setProperty(`--magpie-glass-${name}-blur`, `${part.blur}px`)
    }
  }
  paintGlass()

  // 预览里 options 只活在内存：刷新页面就回到默认值。
  // 第一次 get 时用演示快照的 options 打底——bridge 先于 catalog.js 加载，所以只能惰性取。
  const store = {
    mode: '',
    persona: '',
    agents: [],
    enabled: {},
    pinned: {},
    imports: [],
    refreshAt: 0,
    inline: [],
  }
  let seeded = false

  /** glassy 是真机 onGlass 的订阅表：先记下回调，随后立刻补一次当前值。 */
  const glassy = []
  const api = {
    theme: { dark, lang: 'zh-CN', tokens, glass },
    glass,
    // 预览调试用：告诉页面/截图脚本现在是哪一档
    glassName,
    context: {},
    service: '',
    visible: true,
    ready: Promise.resolve({ dark, lang: 'zh-CN', tokens, glass }),
    onTheme() {},
    onGlass(fn) {
      glassy.push(fn)
      try { fn(glass) } catch { /* 页面自己的回调出错不该弄挂预览壳 */ }
    },
    onVisibility(fn) {
      api._vis = fn
    },
    onAction() {},
    options: {
      async get() {
        if (!seeded) {
          seeded = true
          const snapshot = window.PURGE_CATALOG?.options
          if (snapshot && typeof snapshot === 'object') Object.assign(store, snapshot)
        }
        return JSON.parse(JSON.stringify(store))
      },
      async set(next) {
        seeded = true
        Object.assign(store, JSON.parse(JSON.stringify(next || {})))
        return JSON.parse(JSON.stringify(store))
      },
    },
    read: async () => ({}),
  }
  window.magpie = api
})()
