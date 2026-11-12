// 回复侧：think 块剥离、推脱识别、流式切片。都是纯函数，外加两个 hook 的集成验证。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createStreamStripper,
  looksLikeRefusal,
  replyText,
  stripLeadingThink,
  stripThinkInPlace,
} from '../lib/response.mjs'
import { onEvent, onResponse } from '../hooks.js'

test('stripLeadingThink：去掉开头的 think 块', () => {
  assert.equal(stripLeadingThink('<think>想一想\n这里</think>正文在这'), '正文在这')
  assert.equal(stripLeadingThink('<thinking>a</thinking>\n\n  答案'), '答案')
})

test('stripLeadingThink：不是开头的 think 块不动', () => {
  const s = '先说一句。<think>中间</think>后面'
  assert.equal(stripLeadingThink(s), s)
})

test('stripLeadingThink：没有闭合标签就不动（可能是真在输出中）', () => {
  const s = '<think>还没写完'
  assert.equal(stripLeadingThink(s), s)
})

test('stripThinkInPlace：四种 protocol 的槽位都能剥', () => {
  const anth = { content: [{ type: 'text', text: '<think>x</think>甲' }] }
  assert.equal(stripThinkInPlace(anth), true)
  assert.equal(anth.content[0].text, '甲')

  const chat = { choices: [{ message: { content: '<think>x</think>乙' } }] }
  assert.equal(stripThinkInPlace(chat), true)
  assert.equal(chat.choices[0].message.content, '乙')

  const resp = { output: [{ type: 'message', content: [{ type: 'output_text', text: '<think>x</think>丙' }] }] }
  assert.equal(stripThinkInPlace(resp), true)
  assert.equal(resp.output[0].content[0].text, '丙')

  const gem = { candidates: [{ content: { parts: [{ text: '<think>x</think>丁' }] } }] }
  assert.equal(stripThinkInPlace(gem), true)
  assert.equal(gem.candidates[0].content.parts[0].text, '丁')

  const clean = { content: [{ type: 'text', text: '本来就没有' }] }
  assert.equal(stripThinkInPlace(clean), false)
})

test('looksLikeRefusal：短推脱能认出来', () => {
  assert.equal(looksLikeRefusal('抱歉，我不能帮你做这个。'), true)
  assert.equal(looksLikeRefusal('I\'m sorry, but I can\'t help with that.'), true)
  assert.equal(looksLikeRefusal('无法提供此类内容'), true)
})

test('looksLikeRefusal：带替代方案/代码/步骤的都不算', () => {
  assert.equal(looksLikeRefusal('抱歉，我不能直接给完整代码，但我可以给你思路和步骤。'), false)
  assert.equal(looksLikeRefusal('抱歉不能直接写，不过给你个例子：\n```js\n1\n```'), false)
  assert.equal(looksLikeRefusal('抱歉我不能直接做，不过建议你：\n1. 先备份\n2. 再改配置'), false)
})

test('looksLikeRefusal：正常长回答、空串、超长都不算', () => {
  assert.equal(looksLikeRefusal(''), false)
  assert.equal(looksLikeRefusal('好的，我先说明一下这个配置项的作用，然后给你完整的修改建议。'), false)
  assert.equal(looksLikeRefusal('抱歉，我不能帮你做这个。' + '补充说明'.repeat(100)), false)
})

test('createStreamStripper：标签被切成两块也能剥干净', () => {
  const s = createStreamStripper()
  const parts = ['<thi', 'nk>思', '考中', '</thi', 'nk>', '真正的', '回答']
  const out = parts.map((p) => s.push(p)).join('')
  assert.equal(out, '真正的回答')
})

test('createStreamStripper：没有 think 块就原样透传（含普通 HTML 尖括号）', () => {
  const s = createStreamStripper()
  const parts = ['<div>', 'hi', '</div>']
  assert.equal(parts.map((p) => s.push(p)).join(''), '<div>hi</div>')
})

test('createStreamStripper：普通文本逐段不被吞', () => {
  const s = createStreamStripper()
  assert.equal(s.push('第一段'), '第一段')
  assert.equal(s.push('第二段'), '第二段')
})

test('onResponse：整包回复剥 think 并返回新 body', async () => {
  const body = { content: [{ type: 'text', text: '<think>想</think>正文' }] }
  const out = await onResponse(body, { options: {}, agent: 'claude-code' })
  assert.equal(out, body)
  assert.equal(body.content[0].text, '正文')
})

test('onResponse：stripThink=true 时内容一样也就不返回（不动 body）', async () => {
  const body = { content: [{ type: 'text', text: '正常回复' }] }
  assert.equal(await onResponse(body, { options: {} }), undefined)
})

test('onResponse：开关关掉就完全不碰', async () => {
  const body = { content: [{ type: 'text', text: '<think>想</think>正文' }] }
  await onResponse(body, { options: { stripThink: false } })
  assert.equal(body.content[0].text, '<think>想</think>正文')
})

test('onEvent：流式 delta 里的 think 被剥掉', async () => {
  const ctx = { options: {}, state: {} }
  const evs = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '<think>想' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '法</think>答案' } },
  ]
  const out = []
  for (const ev of evs) {
    const r = await onEvent(ev, ctx)
    const t = r ? ev.delta.text : ''
    if (t) out.push(t)
  }
  assert.equal(out.join(''), '答案')
})

test('onEvent：非文本事件原样放行', async () => {
  const ev = { type: 'message_start', message: {} }
  assert.equal(await onEvent(ev, { options: {}, state: {} }), undefined)
})

test('replyText：各 protocol 取得到可读文本', () => {
  assert.equal(replyText({ content: [{ type: 'text', text: 'a' }] }), 'a')
  assert.equal(replyText({ choices: [{ message: { content: 'b' } }] }), 'b')
  assert.equal(replyText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'c' }] }] }), 'c')
  assert.equal(replyText({ candidates: [{ content: { parts: [{ text: 'd' }] } }] }), 'd')
})
