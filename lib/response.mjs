// 回复侧的两件事，都只「看」不改写（think 块除外）：
//
//   1. 去掉回复开头的 think 块，别让它留在历史里、下一轮又被当成正文；
//   2. 认出「短、无实质内容」的推脱，记一行日志/一条计数给页面看。
//
// 为什么不做重试：网关钩子拿到的是一条已经生成的回复（流式时甚至是半条），
// 重跑模型要改请求，那是 onRequest 的活；这里能做的是让「模型拒了」这件事
// 可观测，而不是替它重来。人设本身也不承诺无条件照做（见 personas/dafeiyu.md），
// 所以这里只统计、不干预——想改行为请换人设/换技能，而不是在回复层硬掰。

export const REFUSAL_HEAD = 120 // 推脱只认开头这么多字
export const REFUSAL_MAX = 300 // 整段超过这个长度就不是「短推脱」了

// 开头就是明确的拒绝语。宁少认不错认：宁可漏掉一条，也不要把正常回答标成拒绝。
const REFUSAL = [
  /^(?:i'?m sorry|i am sorry)[,.!]?\s*(?:but\s+)?i\s*(?:can'?t|cannot|won'?t|am not able to|'m not able to)\b/i,
  /^i\s*(?:can'?t|cannot|won'?t)\s+(?:help|assist|do|provide|write|give|create|generate)\b/i,
  /^i'?m not (?:going to|able to|willing to)\b/i,
  /^(?:no|nope)[,.!]?\s*i\s*(?:won'?t|can'?t|cannot)\b/i,
  /^(?:抱歉|对不起)[，,]?\s*(?:我)?\s*(?:不能|无法|不会|没法|帮不了)/,
  /^我?\s*(?:不能|无法|不会|没法|不可以)\s*(?:帮你|为您|提供|协助|帮助|给出|告诉|教你|写|做|完成)/,
  /^(?:这|那|此事|这个问题)?\s*(?:超出了?|不在)\s*我(?:的)?(?:能力|职责|范围)/,
]

// 这些词表示「后面还有内容」——一旦出现，这条就不是无内容的推脱，而是解释或替代方案。
const OFFER = /(?:here(?:'s|’s| is| are)|i (?:can|will|could) (?:give|show|provide|help|walk|write|share)|let me|below is|作为|我可以|我能|我可以给你|以下|下面|不过|但可以|替代方案|建议你|步骤)/i

const TAG_OPEN = /^\s*<(think|thinking|thought)>/i

/** 去掉开头的一个 think 块；没有就原样返回。 */
export function stripLeadingThink(text) {
  const s = String(text ?? '')
  const m = TAG_OPEN.exec(s)
  if (!m) return s
  const close = new RegExp(`</${m[1]}>`, 'i')
  const idx = s.search(close)
  if (idx < 0) return s
  const rest = s.slice(idx + m[1].length + 3) // 跳过 </tag>
  return rest.replace(/^[\s\u3000]*/, '')
}

/**
 * 流式用的 think 剥离器：标签可能被切在两个 chunk 里（`<thi` + `nk>`），
 * 所以要记住「还没确认的前缀」。规则很简单：
 *   开头还没定下来 → 先攒着；确认是 think 块 → 丢掉直到闭合；确认不是 → 原样吐出。
 */
export function createStreamStripper() {
  let carry = '' // 还没决定去留的缓冲
  let state = 'lead' // lead（还没确定开头）| skip（在 think 块里）| pass（正常输出）
  const OPEN = /^\s*<(think|thinking|thought)>/i
  return {
    push(chunk) {
      let t = String(chunk ?? '')
      if (state === 'pass') return t
      carry += t
      for (;;) {
        if (state === 'lead') {
          const m = OPEN.exec(carry)
          if (m) { state = 'skip'; continue }
          // 还可能是半个标签：前缀是它的真子串就先等
          const probe = carry.replace(/^\s*/, '')
          if (probe.startsWith('<') && '<think><thinking><thought>'.includes(probe)) return ''
          state = 'pass'
          const out = carry
          carry = ''
          return out
        }
        if (state === 'skip') {
          const m = /^\s*<(think|thinking|thought)>/i.exec(carry)
          if (m) {
            const end = new RegExp(`</${m[1]}>`, 'i')
            const idx = carry.search(end)
            if (idx < 0) return ''
            carry = carry.slice(idx + m[1].length + 3)
            state = 'lead'
            continue
          }
          state = 'pass'
          continue
        }
        return ''
      }
    },
  }
}


/** 这条回复像不像「开头一句短推脱、后面没有实质内容」。 */
export function looksLikeRefusal(text) {
  const s = String(text ?? '').trim()
  if (!s || s.length > REFUSAL_MAX) return false
  const head = s.slice(0, REFUSAL_HEAD)
  if (!REFUSAL.some((re) => re.test(head))) return false
  // 认了拒绝语，但后面接着给东西（代码块、编号步骤、「我可以给你」）——不是推脱
  if (/```/.test(s) || /(?:^|\n)\s*\d+[.、)]\s/.test(s)) return false
  if (OFFER.test(s)) return false // 认了拒绝语，但通篇还给了替代方案/步骤——不是空推脱
  return true
}

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('')
  return ''
}

/** 整包回复的可读文本，按 protocol 的 body 形状取。 */
export function replyText(body) {
  const out = []
  const push = (obj, k) => { if (obj && typeof obj[k] === 'string') out.push(obj[k]) }
  if (Array.isArray(body?.content)) for (const b of body.content) if (b && b.type === 'text') push(b, 'text')
  if (Array.isArray(body?.choices)) for (const c of body.choices) push(c?.message, 'content')
  if (Array.isArray(body?.output)) {
    for (const it of body.output) {
      if (it?.type === 'message' && Array.isArray(it.content)) for (const p of it.content) if (p?.type === 'output_text') push(p, 'text')
    }
  }
  if (Array.isArray(body?.candidates)) {
    for (const c of body.candidates) if (Array.isArray(c?.content?.parts)) for (const p of c.content.parts) push(p, 'text')
  }
  return out.join('')
}

/** 就地去 think 块；返回是否改动过。 */
export function stripThinkInPlace(body) {
  let changed = false
  const fix = (obj, k) => {
    if (obj && typeof obj[k] === 'string') {
      const u = stripLeadingThink(obj[k])
      if (u !== obj[k]) { obj[k] = u; changed = true }
    }
  }
  if (Array.isArray(body?.content)) for (const b of body.content) if (b && b.type === 'text') fix(b, 'text')
  if (Array.isArray(body?.choices)) for (const c of body.choices) fix(c?.message, 'content')
  if (Array.isArray(body?.output)) {
    for (const it of body.output) {
      if (it?.type === 'message' && Array.isArray(it.content)) for (const p of it.content) if (p?.type === 'output_text') fix(p, 'text')
    }
  }
  if (Array.isArray(body?.candidates)) {
    for (const c of body.candidates) if (Array.isArray(c?.content?.parts)) for (const p of c.content.parts) fix(p, 'text')
  }
  return changed
}

/** 流式事件里带可见文本的槽位，按 protocol 的事件形状取。 */
export function streamSlots(ev) {
  const out = []
  if (!ev || typeof ev !== 'object') return out
  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') out.push({ obj: ev.delta, key: 'text' })
  else if (ev.type === 'response.output_text.delta') out.push({ obj: ev, key: 'delta' })
  else if (Array.isArray(ev.choices)) {
    for (const c of ev.choices) if (c?.delta && typeof c.delta.content === 'string') out.push({ obj: c.delta, key: 'content' })
  } else if (Array.isArray(ev.candidates)) {
    for (const c of ev.candidates) if (Array.isArray(c?.content?.parts)) for (const p of c.content.parts) if (typeof p?.text === 'string') out.push({ obj: p, key: 'text' })
  }
  return out
}

export { textOf }
