// page/glass.js 的策略：宿主给的四个区域数字 → 页面自己的几层底（画布 / 文字面 / 浮层 / 控件）。
//
// 为什么要单独测：这些数字在真机上只能靠肉眼调，调坏了（文字看不见、控件全透）
// 没法在 Node 测试里复现。这里把「读数字 → 加下限 → 判定深浅」这条策略抽成纯函数，
// 用假 root 跑一遍，锁住三件事：
//   1. 玻璃关闭（100% / 0px）时与没有玻璃的旧行为完全一致；
//   2. 区域数字照抄宿主的，只有文字面、浮层与控件有各自的保底（低不透明时仍读得清）；
//   3. 越界、缺字段、字符串数字都要收敛到安全值，不许把 NaN 写进 CSS 变量。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** loadGlass 把 page/glass.js 当普通脚本跑一遍，取出它挂到全局的那个对象。 */
function loadGlass() {
  const code = readFileSync(join(here, '..', 'page', 'glass.js'), 'utf8')
  // 不给它 document / window：正好也测到「不在浏览器里就不自动挂」。
  const fn = new Function('globalThis', `${code}\nreturn globalThis.PurgeGlass`)
  const api = fn({})
  assert.ok(api && typeof api.apply === 'function', 'page/glass.js 应该导出 apply')
  return api
}

const glass = loadGlass()

/** fakeRoot 是 document.documentElement 的最小替身：只记下页面写进去的东西。 */
function fakeRoot() {
  const props = {}
  return {
    dataset: {},
    props,
    style: {
      setProperty(name, value) { props[name] = value },
      removeProperty(name) { delete props[name] },
    },
    setAttribute(name, value) { this.dataset[name] = value },
    toggleAttribute(name, force) { if (force) this.dataset[name] = ''; else delete this.dataset[name] },
  }
}

const provider = (fills, blurs = {}) => ({
  on: true,
  regions: Object.fromEntries(
    Object.entries(fills).map(([name, fill]) => [name, { fill, blur: blurs[name] ?? 0 }]),
  ),
})

test('玻璃关闭时一切照旧：四个底都是 100%，等级是 off', () => {
  const off = {
    on: false,
    regions: {
      sidebar: { fill: 100, blur: 0 },
      content: { fill: 100, blur: 0 },
      overlay: { fill: 100, blur: 0 },
      control: { fill: 100, blur: 0 },
    },
  }
  const root = fakeRoot()
  const state = glass.apply(root, off)
  assert.equal(state.level, 'off')
  assert.equal(root.dataset.glass, 'off')
  assert.equal(root.props['--purge-glass-canvas-fill'], '100%')
  assert.equal(root.props['--purge-glass-ground-fill'], '100%')
  assert.equal(root.props['--purge-glass-overlay-fill'], '100%')
  assert.equal(root.props['--purge-glass-control-fill'], '100%')
  assert.equal(root.props['--purge-glass-canvas-blur'], '0px')
})

test('宿主的数字照抄：轻透 62/26 原样进画布，文字面跟着它', () => {
  const root = fakeRoot()
  const state = glass.apply(root, provider({ content: 62, overlay: 86, control: 92 }, { content: 26, overlay: 10, control: 8 }))
  assert.equal(state.level, 'lite')
  assert.equal(root.props['--purge-glass-canvas-fill'], '62%')
  assert.equal(root.props['--purge-glass-canvas-blur'], '26px')
  assert.equal(root.props['--purge-glass-ground-fill'], '62%')
  assert.equal(root.props['--purge-glass-overlay-fill'], '86%')
  assert.equal(root.props['--purge-glass-control-fill'], '92%')
})

test('数字一律照抄，不加下限：内容区 40 时卡片就是 40，胶囊靠 CSS 的 10% 淡化', () => {
  const root = fakeRoot()
  const state = glass.apply(root, provider({ content: 40, overlay: 30, control: 20 }))
  assert.equal(state.level, 'deep', '内容区低于 60% 就该进 deep')
  assert.equal(root.props['--purge-glass-canvas-fill'], '40%')
  assert.equal(root.props['--purge-glass-ground-fill'], '40%', '面照抄 content，不抬下限')
  assert.equal(root.props['--purge-glass-overlay-fill'], '30%', '浮层照抄 overlay')
  assert.equal(root.props['--purge-glass-control-fill'], '20%', '控件照抄 control（CSS 侧 ×0.1）')
})

test('全透（0% / 18px）也判定为 deep，但画布就是 0%', () => {
  const root = fakeRoot()
  const state = glass.apply(root, provider({ content: 0, overlay: 0, control: 0 }, { content: 18 }))
  assert.equal(state.level, 'deep')
  assert.equal(root.props['--purge-glass-canvas-fill'], '0%')
  assert.equal(root.props['--purge-glass-canvas-blur'], '18px')
})

test('没有玻璃信息（老宿主 / 直接开页面）时退回实底，不抛错', () => {
  for (const value of [null, undefined, {}, 'nonsense', 42]) {
    const root = fakeRoot()
    const state = glass.apply(root, value)
    assert.equal(state.level, 'off', `${JSON.stringify(value)} 应该按关闭处理`)
    assert.equal(root.props['--purge-glass-canvas-fill'], '100%')
  }
})

test('越界与脏值收敛：fill 夹到 0–100，blur 夹到 0–40，非数字回默认值', () => {
  const root = fakeRoot()
  glass.apply(root, {
    on: true,
    regions: {
      content: { fill: 150, blur: 99 },
      overlay: { fill: -20, blur: -3 },
      control: { fill: ' 62 ', blur: 'α' },
      sidebar: { fill: null, blur: undefined },
    },
  })
  assert.equal(root.props['--purge-glass-canvas-fill'], '100%')
  assert.equal(root.props['--purge-glass-canvas-blur'], '40px')
  assert.equal(root.props['--purge-glass-overlay-fill'], '0%', '负值按 0，直接透')
  assert.equal(root.props['--purge-glass-control-fill'], '62%', '字符串数字要认')
  assert.equal(root.props['--purge-glass-control-blur'], '0px', '非数字 blur 回 0')
  assert.equal(root.props['--purge-glass-ground-fill'], '100%', 'sidebar 不参与页面的底')
})

test('缺区域时按实底处理；宿主只给三个区域时控件跟主界面走', () => {
  // 真机 pagebridge 目前只下发 sidebar / content / overlay；control 缺席时不能退回实底，
  // 否则按钮永远是实心块，看着跟玻璃没接上。
  const root = fakeRoot()
  const state = glass.apply(root, { on: true, regions: { content: { fill: 70, blur: 8 } } })
  assert.equal(state.level, 'lite')
  assert.equal(root.props['--purge-glass-canvas-fill'], '70%')
  assert.equal(root.props['--purge-glass-overlay-fill'], '100%', 'overlay 缺席按实底')
  assert.equal(root.props['--purge-glass-control-fill'], '70%', 'control 缺席跟 content 走')
})

test('on 开着但四个区域都是实底：按 off 处理，别让页面白挂一层', () => {
  const root = fakeRoot()
  const state = glass.apply(root, {
    on: true,
    regions: {
      sidebar: { fill: 100, blur: 0 },
      content: { fill: 100, blur: 0 },
      overlay: { fill: 100, blur: 0 },
      control: { fill: 100, blur: 0 },
    },
  })
  assert.equal(state.level, 'off')
  assert.equal(root.dataset.glass, 'off')
})

test('attach 立刻套一次当前值，之后每次变化都跟着更新，detach 后不再动', () => {
  const root = fakeRoot()
  let notify = null
  const magpie = {
    glass: provider({ content: 82, overlay: 86, control: 92 }, { content: 12 }),
    onGlass(fn) { notify = fn },
  }
  const session = glass.attach(magpie, root)
  assert.equal(session.level, 'lite')
  assert.equal(root.dataset.glass, 'lite')
  assert.equal(root.props['--purge-glass-canvas-fill'], '82%')

  notify(provider({ content: 20 }, { content: 30 }))
  assert.equal(session.level, 'deep')
  assert.equal(root.dataset.glass, 'deep')
  assert.equal(root.props['--purge-glass-canvas-fill'], '20%')

  session.detach()
  notify(provider({ content: 90 }))
  assert.equal(root.dataset.glass, 'deep', '取消订阅之后不该再改页面')
})

test('attach 在没有 magpie、没有 onGlass、宿主订阅就抛错时都不炸', () => {
  const root = fakeRoot()
  const none = glass.attach(undefined, root)
  assert.equal(none.level, 'off')
  assert.equal(root.dataset.glass, 'off')
  assert.equal(typeof none.detach, 'function')

  const noHook = fakeRoot()
  assert.equal(glass.attach({ glass: provider({ content: 66 }) }, noHook).level, 'lite')
  assert.equal(noHook.dataset.glass, 'lite')

  const broken = fakeRoot()
  const session = glass.attach({ glass: null, onGlass() { throw new Error('host broke') } }, broken)
  assert.equal(session.level, 'off')
  assert.equal(broken.dataset.glass, 'off')
})

test('宿主的 ready 里带玻璃：hello 回来时补套一次，不等下一次主题事件', async () => {
  // 真机 pagebridge 的 onGlass 只在「玻璃变了」时回调，hello 那一次不会补调；
  // 所以页面必须自己从 ready 的返回值里再套一次，否则首屏永远是实底。
  const root = fakeRoot()
  const magpie = {
    glass: null,
    onGlass() {},
    ready: Promise.resolve({ dark: true, tokens: {}, glass: provider({ content: 62 }, { content: 26 }) }),
  }
  const session = glass.attach(magpie, root)
  assert.equal(session.level, 'off', '订阅当下还没有值')
  await session.settled
  assert.equal(session.level, 'lite')
  assert.equal(root.props['--purge-glass-canvas-fill'], '62%')
})

test('CSS 侧只认 glass.js 写出的那组变量', () => {
  const css = readFileSync(join(here, '..', 'page', 'style.css'), 'utf8')
  const known = [
    '--purge-glass-canvas-fill',
    '--purge-glass-canvas-blur',
    '--purge-glass-ground-fill',
    '--purge-glass-ground-blur',
    '--purge-glass-overlay-fill',
    '--purge-glass-overlay-blur',
    '--purge-glass-control-fill',
    '--purge-glass-control-blur',
  ]
  const used = new Set([...css.matchAll(/--purge-glass-[a-z-]+/g)].map((m) => m[0]))
  assert.deepEqual([...used].filter((n) => !known.includes(n)), [], '样式里出现了 glass.js 不写的变量')
  // 三个「面」的数字必须用上；canvas-fill 目前没有面需要它（画布整块透明，交给宿主壁纸），允许不用。
  for (const need of [
    '--purge-glass-ground-fill',
    '--purge-glass-overlay-fill',
    '--purge-glass-control-fill',
  ]) {
    assert.ok(used.has(need), `样式应该用到 ${need}`)
  }
})
