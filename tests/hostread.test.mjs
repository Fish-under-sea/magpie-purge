// 页面读自己目录里正文的通道（page/hostread.js）。
//
// 为什么值得单独测：magpie 插件页的 CSP 是 connect-src 'none'，fetch 一定被拦；
// 正文又不许塞回 .js（Defender 会把大段红队手册判成脚本载荷）。于是页面只剩
// 「让宿主窗口代取」这条路——它是页面拿到正文的唯一通道，断了就等于「查看原文」
// 对所有条目失效。这里锁住三条契约：
//   1. 直连 fetch 能用就用它（宿主将来放开 connect-src 时最快）；
//   2. 直连被拦时改走宿主的 asset 调用，二进制要按 UTF-8 解回中文；
//   3. 两条路都断时如实报错，不能悄悄返回空串——那会让按钮看起来「点了没反应」。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * loadHostRead 在一个假宿主里跑一遍 page/hostread.js。
 *
 * 页面侧的脚本是普通 <script>（不是 ESM），所以用 Function 给它一组最小的
 * 浏览器全局：fetch / parent.postMessage / location / addEventListener。
 */
function loadHostRead({ fetchImpl = async () => { throw new Error('should not fetch') }, parentPost = () => {} } = {}) {
  const code = readFileSync(join(here, '..', 'page', 'hostread.js'), 'utf8')
  const listeners = []
  const sandbox = {}
  const parent = { postMessage: parentPost }
  const location = { href: 'http://127.0.0.1:3437/_magpie/plugin/tok/index.html' }
  const fn = new Function(
    'globalThis', 'parent', 'location', 'fetch', 'addEventListener', 'TextDecoder',
    `${code}\n;return globalThis.PurgeHostRead`,
  )
  const api = fn(sandbox, parent, location, fetchImpl, (type, fn) => listeners.push([type, fn]), TextDecoder)
  /** reply 模拟宿主窗口回一条消息（宿主只回自己帧的 source，这里不判 source）。 */
  const reply = (data) => {
    for (const [type, fn] of listeners) if (type === 'message') fn({ data })
  }
  const reset = () => { listeners.length = 0 }
  return { api, reply, reset }
}

const utf8 = (text) => new TextEncoder().encode(text).buffer

test('直连 fetch 通的时候直接用它，不再问宿主', async () => {
  let asked = 0
  const { api } = loadHostRead({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '主干正文' }),
    parentPost: () => { asked++ },
  })
  assert.equal(await api.readText('catalog.json'), '主干正文')
  assert.equal(asked, 0, '直连成功就不该再发 asset 请求')
})

test('fetch 被 CSP 拦下时，走宿主的 asset 调用把正文取回来', async () => {
  let sent = null
  const { api, reply } = loadHostRead({
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    parentPost: (msg) => {
      sent = msg
      // 宿主收到请求后异步回一条消息，负载是 ArrayBuffer
      queueMicrotask(() => reply({ magpie: 1, id: msg.id, result: { type: 'application/json', data: utf8('## 技能：主动扫描\n正文') } }))
    },
  })
  assert.equal(await api.readText('catalog.json?t=1'), '## 技能：主动扫描\n正文')
  assert.equal(sent.magpie, 1, '消息要带 magpie 标记，宿主只认这个')
  assert.equal(sent.method, 'asset', '宿主窗口取页内文件的方法叫 asset')
  assert.equal(sent.params.url, 'http://127.0.0.1:3437/_magpie/plugin/tok/catalog.json?t=1', '要传绝对地址')
  assert.equal(typeof sent.id, 'string', '页面自己发的 id 不能和宿主 bridge 的编号撞')
})

test('宿主返回 Uint8Array 或字符串都能解出来', async () => {
  const { api } = loadHostRead()
  assert.equal(api.decode({ data: new TextEncoder().encode('字节数组') }), '字节数组')
  assert.equal(api.decode({ data: utf8('缓冲区') }), '缓冲区')
  assert.equal(api.decode({ data: '宿主直接给文本' }), '宿主直接给文本')
  assert.throws(() => api.decode(null), /宿主/)
  assert.throws(() => api.decode({ data: 42 }), /宿主/)
})

test('两条路都断了要报出两条原因，不能假装成功', async () => {
  const { api, reply } = loadHostRead({
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    parentPost: (msg) => {
      queueMicrotask(() => reply({ magpie: 1, id: msg.id, error: 'No such call: asset' }))
    },
  })
  await assert.rejects(
    () => api.readText('catalog.json'),
    (error) => /Failed to fetch/.test(error.message) && /asset/.test(error.message),
    '错误里要同时留下直连与宿主通道的原因，否则用户只看到「点不动」',
  )
})

test('宿主不回话时按超时失败，不会永远停在 loading', async () => {
  const { api } = loadHostRead({ fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
  await assert.rejects(
    () => api.readText('catalog.json', { timeoutMs: 20 }),
    /宿主|超时/,
  )
})

test('没有 result 也没有 error 的回声不算宿主回复', async () => {
  // 页面被单独打开时 parent 就是它自己：请求会回到自己这里。
  // 那种消息没有结果，不能当成「取到了空正文」。
  const { api, reply } = loadHostRead({ fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
  setTimeout(() => reply({ magpie: 1, id: 'purge-asset-1' }), 5)
  await assert.rejects(
    () => api.readText('catalog.json', { timeoutMs: 40 }),
    /宿主没有应答/,
  )
})