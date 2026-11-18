// build-preview：把插件页压成一个能直接双击打开的单文件 HTML。
//
// 为什么要有这个：`preview/serve.mjs` 要起服务、要开端口，给别人看界面时多两步。
// 单文件版把 index.html + style.css + app.js + mock 桥 + 演示快照全部内联，
// 双击就能看，还能切主题、切「就绪 / 未就绪」两种状态。
//
//   node tools/build-preview.mjs
//   → preview/purge-preview.html
//
// 生成物是派生文件：改完 page/ 要重新跑一次，别手改它。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => readFileSync(join(here, ...p), 'utf8')

const html = read('page', 'index.html')
const css = read('page', 'style.css')
const app = read('page', 'app.js')
const plan = read('page', 'plan.js')
const glass = read('page', 'glass.js')
const hostread = read('page', 'hostread.js')
const bridge = read('preview', 'bridge.js')
// 品牌标记内联成 data URI：单文件不能有外部依赖，file:// 下取子文件会被拦。
// 注意取的是 index.html 里真正在用的那张（card.png）；以前内联的是 icon.svg，
// 而页面上的 <img src="card.png"> 没被替换，单文件预览的图标一直是坏的。
const mark = readFileSync(join(here, 'page', 'card.png'))
const markUri = `data:image/png;base64,${mark.toString('base64')}`
const ready = read('preview', 'catalog.demo.js')
const blocked = read('preview', 'catalog.blocked.js')

// 两份快照都把 window.PURGE_CATALOG 改名为各自的变量，文件里的注释原样保留。
const rename = (text, name) => text.replaceAll('window.PURGE_CATALOG', `window.${name}`)

// 单文件里参数走 hash（#theme=light&snap=blocked）：
// file:// 下的 ?query 在部分场合会被当成文件名的一部分，hash 则稳定可用。
const catalogBlock = `
;(() => {
  const pick = () => {
    const q = new URLSearchParams(location.hash.slice(1) || location.search.slice(1))
    return { theme: q.get('theme') === 'light' ? 'light' : 'dark', snap: q.get('snap') === 'blocked' ? 'blocked' : 'ready' }
  }
  const { snap } = pick()
  window.PURGE_CATALOG = snap === 'blocked' ? window.__PURGE_BLOCKED__ : window.__PURGE_READY__
  window.__PURGE_PICK__ = pick
})()
`

// 顶部控制条：单文件里没有 magpie 外壳，给几个开关，免得全靠手改 URL。
const chrome = `
<div class="pv-bar" role="region" aria-label="预览控制">
  <b>破甲 · Purge</b>
  <span class="pv-hint">单文件预览：数据是演示快照，不跑网关、不写设置</span>
  <label>主题
    <select id="pv-theme">
      <option value="dark">深色</option>
      <option value="light">浅色</option>
    </select>
  </label>
  <label>玻璃
    <select id="pv-glass">
      <option value="off">关闭</option>
      <option value="lite">轻透</option>
      <option value="balanced">均衡</option>
      <option value="clear">全透</option>
    </select>
  </label>
  <label>状态
    <select id="pv-snap">
      <option value="ready">就绪</option>
      <option value="blocked">未就绪</option>
    </select>
  </label>
</div>
<script>
;(() => {
  const q = new URLSearchParams(location.hash.slice(1) || location.search.slice(1))
  const theme = document.getElementById('pv-theme')
  const glass = document.getElementById('pv-glass')
  const snap = document.getElementById('pv-snap')
  theme.value = q.get('theme') === 'light' ? 'light' : 'dark'
  glass.value = ['off', 'lite', 'balanced', 'clear'].includes(q.get('glass')) ? q.get('glass') : 'off'
  snap.value = q.get('snap') === 'blocked' ? 'blocked' : 'ready'
  const go = () => {
    const next = new URLSearchParams()
    next.set('theme', theme.value)
    next.set('glass', glass.value)
    next.set('snap', snap.value)
    location.hash = next.toString()
    location.reload()
  }
  theme.onchange = go
  glass.onchange = go
  snap.onchange = go

  // #row=N 直接打开某条的详情，省得每次都手点
  const row = q.get('row')
  if (row !== null) {
    addEventListener('load', () => setTimeout(() => {
      document.querySelectorAll('#list .row')[Number(row)]?.click()
    }, 120))
  }
})()
</script>
`

const out = html
  // 外链资源换成内联。三个匹配都用正则带上 ?v=：打包时 prepack 会给它们打版本号，
  // 用固定字符串匹配会在 prepack 之后失效，单文件预览就整份不内联了。
  .replace(/<link rel="stylesheet" href="style\.css[^"]*">/, `<style>\n${css}\n/* ---- 预览控制条 ---- */\n.pv-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--line);background:var(--card);font:12px/1.4 var(--magpie-font,system-ui);color:var(--ink)}
.pv-bar b{font-size:13px;font-weight:600}
.pv-hint{color:var(--muted);margin-right:auto}
.pv-bar label{display:flex;align-items:center;gap:6px;color:var(--muted)}
.pv-bar select{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
/* 单文件预览没有宿主帧：壁纸垫在画布下面，画布的不透明度才看得出效果。
   真机里壁纸画在 magpie 的 body 上（带 --wall-veil 遮罩），这里用两块柔光渐变代它；
   画布这一层照抄页面自己的写法，玻璃关闭（100%）时它盖住壁纸，与旧版一致。 */
/* 单文件预览没有宿主帧：玻璃开着时给 html 垫「遮罩 + 壁纸」两层，画布本身全透。
   真机里壁纸画在 magpie 的 body 上（带 --wall-veil 遮罩），页面 html 是透明的；
   这里用同样的层序模拟，玻璃关闭时走页面自己的 html{background:var(--bg)}。 */
html[data-magpie-glass]{background:linear-gradient(color-mix(in srgb,#0f1115 45%,transparent),color-mix(in srgb,#0f1115 45%,transparent)),radial-gradient(900px 700px at 14% 0%,#3d5fa8 0%,transparent 60%),radial-gradient(800px 620px at 96% 100%,#8c3a5f 0%,transparent 56%),radial-gradient(680px 520px at 82% 6%,#1f7a6a 0%,transparent 52%),linear-gradient(160deg,#0b0d14,#1b2233)}
html[data-theme="light"][data-magpie-glass]{background:linear-gradient(color-mix(in srgb,#f4f4f2 45%,transparent),color-mix(in srgb,#f4f4f2 45%,transparent)),radial-gradient(900px 700px at 12% 0%,#b9d4ff 0%,transparent 60%),radial-gradient(800px 620px at 96% 100%,#ffc2d4 0%,transparent 56%),radial-gradient(680px 520px at 82% 6%,#ffe4b8 0%,transparent 52%),linear-gradient(160deg,#fdfdff,#eef2fb)}
</style>`)
  .replace('<script src="_magpie/bridge.js"></script>', `<script>\n${bridge.replace(
    'new URLSearchParams(location.search)',
    // 单文件用 hash 传参，桥也跟着读 hash
    "new URLSearchParams(location.hash.slice(1) || location.search.slice(1))",
  )}\n</script>`)
  .replace(/<script src="catalog\.js[^"]*"><\/script>/, `<script>\n${rename(ready, '__PURGE_READY__')}\n</script>\n<script>\n${rename(blocked, '__PURGE_BLOCKED__')}\n</script>\n<script>${catalogBlock}</script>\n<script>window.__PURGE_SINGLE_FILE__ = true</script>`)
  // app.js 原本是 defer：内联到 <head> 里会赶在 DOM 之前跑，什么都取不到。
  // 所以从这个位置摘掉，放到 </body> 前。
  .replace(/<script src="app\.js[^"]*" defer><\/script>/, '')
  // plan.js / glass.js 是纯计算/只碰文档根，留在原位内联即可（app.js 依赖它们）。
  .replace(/<script src="plan\.js[^"]*"><\/script>/, `<script>\n${plan}\n</script>`)
  .replace(/<script src="glass\.js[^"]*" defer><\/script>/, `<script>\n${glass}\n</script>`)
  // hostread.js 同理：app.js 一启动就要用它取正文。
  .replace(/<script src="hostread\.js[^"]*" defer><\/script>/, `<script>\n${hostread}\n</script>`)
  .replace('</body>', `<script>\n${app}\n</script>\n</body>`)
  .replace('src="card.png"', `src="${markUri}"`)
  .replace('<body>', `<body>\n${chrome}`)
  .replace('<title>破甲 · Purge</title>', '<title>破甲 · Purge（单文件预览）</title>')

writeFileSync(join(here, 'preview', 'purge-preview.html'), out, 'utf8')
console.log(`preview/purge-preview.html  ${(Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)} KiB`)