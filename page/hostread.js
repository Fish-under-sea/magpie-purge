// 页面读自己目录里的数据文件（正文快照 catalog.json）。
//
// 为什么不能直接 fetch：magpie 给插件页的 CSP 是 connect-src 'none'，fetch 一律
// 被拦；正文又不能塞回 .js——内置技能是一批红队手册，整段内联进脚本会被 Defender
// 判成 Trojan:Script/Wacatac.C!ml（见 lib/state.mjs 的 writeSnapshotIfChanged）。
//
// 于是走 magpie 自己给这类页面留的那条通道：页面桥在「整页内联」的页面上取脚本时，
// 就是让宿主窗口用它的身份去读页内文件（pagebridge.js 的 asset 调用 →
// pluginpages.js 的 answer → pageshare.js 的 pageAsset，只许读页面自己目录下的文件）。
// 这里发同一种消息，把 catalog.json 要回来：CSP 拦得住页面，拦不住窗口自己的 fetch。
//
// 两条通道按顺序试，先快后慢：
//   1. 直连 fetch——宿主哪天把 connect-src 放开到自身目录，这条最快；
//   2. 宿主代取——现在的真机走这条。
// 两条都断时把两个原因一起抛出去，而不是返回空串：空串会变成「按钮点了没反应」。
;(() => {
  /** SOURCE_TIMEOUT 是等宿主回话的上限：超过了就当这条路断了，别让页面卡在 loading。 */
  const SOURCE_TIMEOUT = 5000
  /** 页面自己的消息编号带前缀，避免和宿主桥的递增数字编号撞上。 */
  const ID_PREFIX = 'purge-asset-'
  let seq = 0
  const pending = new Map()

  /**
   * asset 让宿主窗口把这个地址的文件取回来。
   *
   * params.url 必须是页面自己目录下的绝对地址：宿主那边会先校验前缀，
   * 不是页内文件一律拒绝。
   */
  function asset(url, timeoutMs = SOURCE_TIMEOUT) {
    const id = `${ID_PREFIX}${++seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`宿主没有应答（${timeoutMs} ms）`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      parent.postMessage({ magpie: 1, id, method: 'asset', params: { url } }, '*')
    })
  }

  addEventListener('message', (ev) => {
    const m = ev.data
    if (!m || m.magpie !== 1 || typeof m.id !== 'string' || !m.id.startsWith(ID_PREFIX)) return
    const waiting = pending.get(m.id)
    if (!waiting) return
    // 只有带 result 或 error 的才算回复：页面被单独打开时 parent 就是它自己，
    // 自己发出去的请求会回到自己这里，没有结果的那些不能当成「取到了」。
    if (!m.error && m.result === undefined) return
    pending.delete(m.id)
    clearTimeout(waiting.timer)
    if (m.error) waiting.reject(new Error(String(m.error)))
    else waiting.resolve(m.result)
  })

  /** bytesOf 把宿主给的内容解成字节：ArrayBuffer、Uint8Array 都认。 */
  function bytesOf(blob) {
    if (blob instanceof Uint8Array) return blob
    if (typeof ArrayBuffer !== 'undefined' && blob instanceof ArrayBuffer) return new Uint8Array(blob)
    return null
  }

  /**
   * decode 把宿主返回的 {type, data} 解成文本。
   *
   * data 正常是 ArrayBuffer（pageAsset 的 arrayBuffer），但老宿主、或者以后
   * 宿主直接给字符串，也要认——页面这边不该挑剔它的形状。
   */
  function decode(result) {
    const data = result && result.data
    if (typeof data === 'string') return data
    const bytes = bytesOf(data)
    if (!bytes) throw new Error('宿主给的内容读不出来')
    return new TextDecoder('utf-8').decode(bytes)
  }

  /**
   * readText 读页面目录里的一个文件，返回它的文本。
   *
   * path 相对页面自身地址（index.html），可以带 ?t= 这种防缓存参数。
   */
  async function readText(path, { timeoutMs = SOURCE_TIMEOUT } = {}) {
    const url = new URL(String(path), location.href).href
    let directError = null
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (res.ok) return await res.text()
      directError = new Error(`HTTP ${res.status}`)
    } catch (error) {
      directError = error
    }
    try {
      return decode(await asset(url, timeoutMs))
    } catch (hostError) {
      // 两条原因都留着：用户看到的提示要能指向真正断掉的那条通道
      throw new Error(`直连取正文失败（${directError?.message || directError}）；让宿主窗口代取也失败（${hostError?.message || hostError}）`)
    }
  }

  globalThis.PurgeHostRead = { readText, asset, decode }
})()