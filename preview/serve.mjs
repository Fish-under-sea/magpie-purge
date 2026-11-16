// 本地预览：把真实插件页放进一个 mock 宿主帧里，只为人工看界面。
//
// 不实现网关、不跑 hooks、不碰真实 options；主题跟随 magpie 的变量名，
// 明暗由 ?theme=dark|light 决定。
//
//   node preview/serve.mjs                 → http://127.0.0.1:55133
//   node preview/serve.mjs --demo          → 用 preview/catalog.demo.js 顶替真实快照
//   node preview/serve.mjs --demo=blocked  → 只有素材、没选模式那一屏
//   node preview/serve.mjs --csp=magpie    → 用真机同款 CSP（connect-src 'none'）发页面，
//                                            用来复现「页面 fetch 被拦、只能让宿主代取」
//   node preview/serve.mjs --demo --watch  → 改完 page/ 自动重载（调 UI 时开这个）
//
// 真机里 page/catalog.js 由 hooks.js 扫描后写出；预览里要么用它，要么用演示快照。
import { watch } from 'node:fs'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = normalize(join(here, '..'))
const demoArg = process.argv.find((a) => a === '--demo' || a.startsWith('--demo='))
const demoFile = demoArg ? (demoArg.includes('=') ? `catalog.${demoArg.split('=')[1]}.js` : 'catalog.demo.js') : ''
const cspArg = process.argv.find((a) => a.startsWith('--csp='))
const csp = cspArg ? cspArg.split('=')[1] : ''
const watchMode = process.argv.includes('--watch')
const port = Number(process.env.PREVIEW_PORT || 55133)

/**
 * fillTexts 给演示条目补回正文。
 *
 * 演示快照里的 text 一律是空的（仓库不再放手册合集，见 build-demo.mjs 的注释）。
 * 预览要验证「查看原文」，就必须有正文可看——这里在发请求时从 skills/、personas/
 * 现读，等于在预览里重放一次真机的「按路径取正文」。
 */
function fillTexts(parsed) {
  for (const e of parsed?.entries || []) {
    if (typeof e.text === 'string' && e.text.trim()) continue
    const rel = e.source?.rel
    if (!rel) continue
    const folder = e.source.root === '（包内）skills' ? 'skills' : e.source.root === '（包内）personas' ? 'personas' : ''
    if (!folder) continue
    try {
      const raw = readFileSync(join(root, folder, rel), 'utf8')
      const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
      e.text = m ? raw.slice(m[0].length).trim() : raw.trim()
    } catch { /* 读不到就留空：页面会照实说「正文没取到」 */ }
  }
  return parsed
}

/**
 * parseDemo 把演示快照脚本求值成一个普通对象。
 *
 * demo 文件是 `window.PURGE_CATALOG = {…}` 再加两段预览开关（?unsent / ?inline），
 * 所以不能直接 JSON.parse。这里给它一个假的 window/location 跑一遍，
 * 顺便让那两个开关继续生效。
 */
function parseDemo(code, search = '') {
  const win = {}
  const fakeLocation = { search }
  const fn = new Function('window', 'location', 'URLSearchParams', `${code}\n;return window.PURGE_CATALOG`)
  return fn(win, fakeLocation, URLSearchParams)
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

// 监听页面的客户端。--watch 时把它们挂在 /_reload 上，文件一动就推一条消息。
const listeners = new Set()
function broadcast() {
  for (const res of listeners) {
    try {
      res.write('data: reload\n\n')
    } catch {
      listeners.delete(res)
    }
  }
}

if (watchMode) {
  let timer = 0
  for (const dir of ['page', 'preview']) {
    watch(join(root, dir), { recursive: true }, (_event, file) => {
      // 只认真正会被浏览器读的文件；catalog.js 由构建脚本写，不算改动。
      if (!file || !/\.(html|css|js|mjs|svg|png)$/.test(file)) return
      if (file.endsWith('catalog.js')) return
      clearTimeout(timer)
      timer = setTimeout(broadcast, 80)
    })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = decodeURIComponent(url.pathname)
  const send = (body, type, code = 200, headers = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...headers })
    res.end(body)
  }
  /** 页面文档（HTML）才带 CSP：真机里那条 connect-src 'none' 就挂在页面上。 */
  const pagePolicy = (file) => (csp === 'magpie' && /\.html$/.test(file)
    ? { 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'" }
    : {})

  // 热重载通道：保持连接，文件一变就推一条；客户端断了就从集合里摘掉。
  if (pathname === '/_reload') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    listeners.add(res)
    req.on('close', () => listeners.delete(res))
    return
  }

  try {
    if (pathname === '/' || pathname === '/host.html') {
      return send(await readFile(join(here, 'host.html'), 'utf8'), mime['.html'])
    }
    // 页面加载的 _magpie/bridge.js：真机由 magpie 提供，预览用 mock
    if (pathname.endsWith('/_magpie/bridge.js')) {
      return send(await readFile(join(here, 'bridge.js'), 'utf8'), mime['.js'])
    }
    // 预览也要走「脚本只有元数据、正文在 .json」这条路，否则测不到真实行为。
    // demoFile 里是带正文的完整快照，这里按后缀拆成两份发。
    if ((pathname.endsWith('/catalog.js') || pathname.endsWith('/catalog.json')) && demoFile) {
      const parsed = fillTexts(parseDemo(await readFile(join(here, demoFile), 'utf8'), url.search))
      if (pathname.endsWith('/catalog.json')) return send(`${JSON.stringify(parsed, null, 2)}\n`, mime['.json'] || 'application/json')
      const stripped = { ...parsed, entries: (parsed.entries || []).map((e) => ({ ...e, text: '' })) }
      return send(`window.PURGE_CATALOG = ${JSON.stringify(stripped, null, 2)};\n`, mime['.js'])
    }
    const file = pathname.startsWith('/page/') ? join(root, 'page', pathname.slice(6)) : join(root, pathname)
    if (!file.startsWith(root)) return send('forbidden', 'text/plain', 403)
    return send(await readFile(file), mime[extname(file)] || 'application/octet-stream', 200, pagePolicy(file))
  } catch {
    return send('not found', 'text/plain', 404)
  }
})

server.listen(port, '127.0.0.1', () => {
  const bits = [`http://127.0.0.1:${port}`]
  if (demoFile) bits.push(`?theme=light 切浅色；演示快照 ${demoFile}`)
  else bits.push('?theme=light 切浅色')
  console.log(`purge preview: ${bits.join('\n               ')}`)
  if (watchMode) console.log('               已开热重载：改 page/ 会自动刷新（?watch=0 可关）')
})
