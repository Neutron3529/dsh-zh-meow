/**
 * DeepSeek 前缀续写的纯逻辑。
 *
 * 这个模块不依赖任何宿主包，方便在纯 Node 测试里直接 import：
 *   - 请求消息从 DSH 的 provider-neutral 结构转成 OpenAI Chat Completions；
 *   - 按配置的 role 规则决定要不要在末尾插入 assistant 前缀消息；
 *   - 解析 SSE、把 OpenAI 增量转成 DSH 的 StreamChunk；
 *   - 把服务器返回的 reasoning 接在已发送前缀之后。
 *
 * @module zh-meow/deepseek-prefix-core
 */

/** 默认端点：DeepSeek 的 OpenAI 兼容 beta 入口。 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/beta'

/** 默认前缀规则：user 与 tool 两种 role。 */
export const DEFAULT_PREFIX_RULES = [
  { role: 'user', reasoning_content: '让我想想喵~' },
  { role: 'tool', reasoning_content: '让我看看喵~' },
]

/**
 * 前缀模块自己的错误；adapter 会把它包成宿主认识的 LlmError。
 *
 * 用独立的错误类而不是直接 import LlmError，是为了让核心逻辑保持零依赖。
 */
export class PrefixError extends Error {
  /**
   * @param {string} message 面向人的错误说明。
   * @param {string} code 稳定的错误码，例如 INVALID_REQUEST / MALFORMED_RESPONSE。
   */
  constructor(message, code) {
    super(message)
    this.name = 'PrefixError'
    this.code = code
  }
}

/**
 * 判断一个值是不是可当作字典用的普通对象。
 * @param {unknown} value 待判断的值。
 * @returns {boolean} 是否为非 null、非数组的对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把配置里的规则数组归一化。
 *
 * undefined 或非数组回退默认规则；显式空数组表示「没有规则，不插前缀」。
 * 空 role、非对象条目、非字符串 reasoning_content 一律过滤。
 * @param {unknown} raw 设置页或旧配置里的规则数组。
 * @returns {Array<{ role: string, reasoning_content: string }>} 归一化后的规则。
 */
export function normalizePrefixRules(raw) {
  if (raw === undefined || raw === null || !Array.isArray(raw)) {
    return DEFAULT_PREFIX_RULES.map(rule => ({ ...rule }))
  }
  const rules = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const role = typeof item.role === 'string' ? item.role.trim() : ''
    if (role.length === 0) continue
    const reasoning = typeof item.reasoning_content === 'string' ? item.reasoning_content : ''
    rules.push({ role, reasoning_content: reasoning })
  }
  return rules
}

/**
 * 归一化并校验端点。
 *
 * 空串回退默认端点；去掉末尾斜杠；拒绝带凭据、查询或片段的地址。
 * @param {unknown} value 设置页里的端点。
 * @returns {string} 可直接拼接 /chat/completions 的根地址。
 * @throws {PrefixError} URL 非法时抛出 INVALID_REQUEST。
 */
export function normalizeBaseURL(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const candidate = raw.length > 0 ? raw.replace(/\/+$/, '') : DEFAULT_BASE_URL
  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    throw new PrefixError('DeepSeek Beta baseURL 不是合法 URL：' + candidate, 'INVALID_REQUEST')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0) {
    throw new PrefixError('DeepSeek Beta baseURL 必须是去掉凭据、查询与片段的 HTTP(S) 根地址', 'INVALID_REQUEST')
  }
  return candidate
}

/**
 * 根据原版请求的最后一条消息匹配前缀规则。
 *
 * 规则数组按顺序匹配；重复 role 时第一条生效。命中但内容为空时返回
 * undefined，表示这个 role 被临时禁用，不再继续找后续同 role 规则。
 * @param {readonly object[]} messages DSH 的原始请求消息。
 * @param {{ enabled?: boolean, rules?: unknown, thinking?: boolean }} [options] 开关、规则与思考状态。
 * @returns {{ matchedRole: string, text: string } | undefined} 命中的规则。
 */
export function selectPrefix(messages, options = {}) {
  const { enabled = true, rules = DEFAULT_PREFIX_RULES, thinking = true } = options
  if (!enabled || !thinking) return undefined
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const last = messages[messages.length - 1]
  const role = isPlainObject(last) && typeof last.role === 'string' ? last.role.trim() : ''
  if (role.length === 0) return undefined
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!isPlainObject(rule) || rule.role !== role) continue
    const text = typeof rule.reasoning_content === 'string' ? rule.reasoning_content : ''
    if (text.trim().length === 0) return undefined
    return { matchedRole: role, text }
  }
  return undefined
}

/**
 * 把 DSH 的内容块压成纯文本。
 *
 * 图片与文件块在正常流程里会被 DSH 提前投影；这里保留占位符只是防御。
 * @param {unknown} content 消息内容块数组，或已经是字符串。
 * @returns {string} 拼接后的文本。
 */
export function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!isPlainObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push('[file]')
  }
  return parts.join('')
}

/**
 * 把一条 DSH assistant 消息转成 OpenAI assistant 消息。
 *
 * reasoning 块进 reasoning_content，text 块进 content，tool-call 块进
 * tool_calls；三者全空的消息跳过，避免发出空消息破坏缓存前缀。
 * @param {object} message DSH assistant 消息。
 * @returns {object | undefined} OpenAI 消息。
 */
function toAssistantMessage(message) {
  const blocks = Array.isArray(message.content) ? message.content : []
  const reasoningParts = []
  const textParts = []
  const toolCalls = []
  for (const block of blocks) {
    if (!isPlainObject(block)) continue
    if (block.type === 'reasoning' && typeof block.text === 'string') {
      reasoningParts.push(block.text)
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
      continue
    }
    if (block.type === 'tool-call') {
      toolCalls.push({
        id: typeof block.id === 'string' && block.id.length > 0 ? block.id : 'call_' + toolCalls.length,
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : '',
          arguments: typeof block.arguments === 'string' && block.arguments.length > 0 ? block.arguments : '{}',
        },
      })
    }
  }
  const reasoning = reasoningParts.join('')
  const text = textParts.join('')
  if (reasoning.length === 0 && text.length === 0 && toolCalls.length === 0) return undefined
  return {
    role: 'assistant',
    content: text,
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * 把 DSH 请求消息转成 OpenAI Chat Completions 消息。
 *
 * system 与 developer 的文本统一合并到开头一条 system 消息：OpenAI 兼容
 * 端点通常只在开头读 system，合并后每轮前缀仍然稳定。developer 里的
 * tool-addition / tool-removal 块忽略，因为 tools 数组始终是完整声明。
 * @param {readonly object[]} messages DSH 请求消息。
 * @param {{ system?: string }} [options] 一次性调用附带的 system 文本。
 * @returns {object[]} OpenAI 消息数组（不含前缀消息）。
 */
export function toChatMessages(messages, options = {}) {
  const systemParts = []
  if (typeof options.system === 'string' && options.system.length > 0) systemParts.push(options.system)
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isPlainObject(message)) continue
    if (message.role === 'system' || message.role === 'developer') {
      const text = blocksToText(message.content)
      if (text.length > 0) systemParts.push(text)
      continue
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: blocksToText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const converted = toAssistantMessage(message)
      if (converted !== undefined) out.push(converted)
      continue
    }
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
        content: blocksToText(message.content),
      })
    }
  }
  if (systemParts.length > 0) out.unshift({ role: 'system', content: systemParts.join('\n\n') })
  return out
}

/**
 * 把一个 DSH 工具 schema 转成 OpenAI function 工具。
 * @param {object} tool DSH 工具定义。
 * @returns {object} OpenAI 工具定义。
 */
function toOpenAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: typeof tool.name === 'string' ? tool.name : '',
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: isPlainObject(tool.parameters)
        ? tool.parameters
        : { type: 'object', properties: {} },
    },
  }
}

/**
 * 构造一次 DeepSeek Beta 请求。
 * @param {object} options DSH 的 GenerateOptions。
 * @param {{ enabled?: boolean, rules?: unknown }} [settings] 前缀配置。
 * 当请求携带 tool 定义时跳过前缀：DeepSeek Beta 会以
 * "Function call should not be used with prefix" 拒绝该组合。
 * @returns {{ body: object, prefix: { matchedRole: string, text: string } | undefined, suppressed: 'tools' | undefined }} 请求体、已插入的前缀与抑制原因。
 */
export function buildChatRequest(options, settings = {}) {
  const effort = typeof options.reasoningEffort === 'string' ? options.reasoningEffort : undefined
  const thinking = effort !== 'off'
  const matched = selectPrefix(options.messages, {
    enabled: settings.enabled !== false,
    rules: settings.rules,
    thinking,
  })
  const hasTools = Array.isArray(options.tools) && options.tools.length > 0
  const prefix = hasTools ? undefined : matched
  const suppressed = hasTools && matched !== undefined ? 'tools' : undefined
  const messages = toChatMessages(options.messages, { system: options.system })
  if (prefix !== undefined) {
    messages.push({
      role: 'assistant',
      content: '',
      reasoning_content: prefix.text,
      prefix: true,
    })
  }
  const body = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(Array.isArray(options.stop) && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(Array.isArray(options.tools) && options.tools.length > 0 ? { tools: options.tools.map(toOpenAiTool) } : {}),
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    ...(thinking && effort !== undefined ? { reasoning_effort: effort } : {}),
  }
  return { body, prefix, suppressed }
}

/**
 * 创建一个 SSE 解析器。
 *
 * 按空行分帧，支持跨 chunk 的多行 data；注释行与 event 字段忽略。
 * @returns {{ push: (text: string) => string[], end: () => string[] }} 解析器。
 */
export function createSseParser() {
  let buffer = ''
  let dataLines = []
  let ended = false
  return {
    push(text) {
      if (ended || typeof text !== 'string' || text.length === 0) return []
      buffer += text
      const events = []
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const raw = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line.length === 0) {
          if (dataLines.length > 0) {
            events.push(dataLines.join('\n'))
            dataLines = []
          }
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') dataLines.push(value)
      }
      return events
    },
    end() {
      if (ended) return []
      ended = true
      const events = []
      if (buffer.length > 0) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
        buffer = ''
        if (line.startsWith('data:')) {
          let value = line.slice(5)
          if (value.startsWith(' ')) value = value.slice(1)
          dataLines.push(value)
        }
      }
      if (dataLines.length > 0) {
        events.push(dataLines.join('\n'))
        dataLines = []
      }
      return events
    },
  }
}

/**
 * 把一段 SSE data 解析成 JSON 对象。
 * @param {string} data data 字段内容。
 * @returns {object | undefined} 解析结果。
 * @throws {PrefixError} 不是合法 JSON 时抛出 MALFORMED_RESPONSE。
 */
function parseSseData(data) {
  const text = data.trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new PrefixError('DeepSeek Beta 返回了无法解析的 SSE 数据：' + text.slice(0, 200), 'MALFORMED_RESPONSE')
  }
}

/**
 * 把响应体解析成 SSE 事件异步迭代器。
 * @param {ReadableStream<Uint8Array>} body fetch 响应体。
 * @returns {AsyncGenerator<object>} 已解析的 JSON 事件。
 */
export async function* parseSseStream(body) {
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    throw new PrefixError('DeepSeek Beta 响应缺少可读取的 body', 'TRANSPORT')
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = createSseParser()
  let done = false
  try {
    while (!done) {
      const read = await reader.read()
      if (read.done) break
      for (const data of parser.push(decoder.decode(read.value, { stream: true }))) {
        if (data.trim() === '[DONE]') { done = true; break }
        const event = parseSseData(data)
        if (event !== undefined) yield event
      }
    }
    if (!done) {
      for (const data of parser.push(decoder.decode())) {
        if (data.trim() === '[DONE]') { done = true; break }
        const event = parseSseData(data)
        if (event !== undefined) yield event
      }
    }
    if (!done) {
      for (const data of parser.end()) {
        if (data.trim() === '[DONE]') { done = true; break }
        const event = parseSseData(data)
        if (event !== undefined) yield event
      }
    }
  } finally {
    try { reader.releaseLock?.() } catch { /* 释放失败不影响已经结束的流 */ }
  }
}

/**
 * 把 OpenAI usage 转成 DSH 的 TokenUsage。
 * @param {unknown} raw 响应里的 usage。
 * @returns {object} DSH 的 usage。
 */
export function mapUsage(raw) {
  if (!isPlainObject(raw)) return { inputTokens: 0, outputTokens: 0 }
  const prompt = nonNegativeInteger(raw.prompt_tokens)
  const hit = Math.min(prompt, nonNegativeInteger(
    raw.prompt_cache_hit_tokens
      ?? (isPlainObject(raw.prompt_tokens_details) ? raw.prompt_tokens_details.cached_tokens : undefined),
  ))
  const completion = nonNegativeInteger(raw.completion_tokens)
  const total = nonNegativeInteger(raw.total_tokens)
  const reasoning = nonNegativeInteger(
    isPlainObject(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : undefined,
  )
  return {
    inputTokens: Math.max(0, prompt - hit),
    outputTokens: completion,
    ...(total > 0 ? { totalTokens: total } : {}),
    ...(hit > 0 ? { cacheReadTokens: hit } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

/**
 * 把非负整数转成 number；非法值按 0 处理。
 * @param {unknown} value 待转换的值。
 * @returns {number} 非负整数。
 */
function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * 把 OpenAI finish_reason 转成 DSH 的 FinishReason。
 * @param {unknown} raw 响应里的 finish_reason。
 * @returns {object} DSH 的 finish reason。
 */
export function mapFinishReason(raw) {
  switch (raw) {
    case 'stop': return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'content_filter':
      return { kind: 'error', failure: { message: 'DeepSeek 内容过滤中止了响应', code: 'CONTENT_FILTER' } }
    case 'insufficient_system_resource':
      return { kind: 'error', failure: { message: 'DeepSeek 报告系统资源不足', code: 'INSUFFICIENT_RESOURCE' } }
    case 'aborted':
      return { kind: 'aborted', failure: { message: 'DeepSeek 中止了响应', code: 'ABORTED' } }
    default:
      return {
        kind: 'error',
        failure: { message: 'DeepSeek 返回了未知的 finish_reason：' + String(raw), code: 'MALFORMED_RESPONSE' },
      }
  }
}

/**
 * 把 OpenAI 流事件转成 DSH 的 StreamChunk。
 *
 * reasoning 的处理是重点：收到第一个 reasoning 增量时先把「已发送前缀」
 * 作为 reasoning-delta 发出去，再把服务器返回的内容接在后面；如果服务器
 * 返回的是完整内容（已经包含前缀），去掉开头的前缀避免重复。
 * @param {AsyncIterable<object>} events 已解析的 SSE 事件。
 * @param {{ prefix?: string }} [options] 本次请求实际发送的 reasoning 前缀。
 * @returns {AsyncGenerator<object>} DSH 的流 chunk。
 */
export async function* translateOpenAiStream(events, options = {}) {
  const sentPrefix = typeof options.prefix === 'string' ? options.prefix : ''
  let nextIndex = 0
  let sawAny = false
  let reasoning
  let text
  const toolCalls = new Map()
  let usage
  let finishReason

  function* startReasoning() {
    if (reasoning !== undefined) return
    reasoning = {
      index: nextIndex++,
      text: '',
      pending: [],
      decided: sentPrefix.length === 0,
    }
    yield { type: 'block-start', index: reasoning.index, blockType: 'reasoning' }
    if (sentPrefix.length > 0) {
      reasoning.text += sentPrefix
      yield { type: 'reasoning-delta', index: reasoning.index, text: sentPrefix }
    }
  }

  function* decideReasoning(force) {
    if (reasoning === undefined || reasoning.decided) return
    const joined = reasoning.pending.join('')
    if (!force && joined.length < sentPrefix.length) return
    reasoning.pending = []
    reasoning.decided = true
    const strip = sentPrefix.length > 0 && joined.startsWith(sentPrefix) ? sentPrefix.length : 0
    const emit = joined.slice(strip)
    if (emit.length > 0) {
      reasoning.text += emit
      sawAny = true
      yield { type: 'reasoning-delta', index: reasoning.index, text: emit }
    }
  }

  for await (const event of events) {
    if (!isPlainObject(event)) continue
    if (event.usage !== undefined) usage = mapUsage(event.usage)
    const choices = Array.isArray(event.choices) ? event.choices : []
    for (const choice of choices) {
      if (!isPlainObject(choice)) continue
      if (choice.index !== undefined && choice.index !== 0) continue
      const delta = isPlainObject(choice.delta) ? choice.delta : undefined
      if (delta !== undefined) {
        const reasoningDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
        if (reasoningDelta.length > 0) {
          sawAny = true
          if (reasoning === undefined) yield* startReasoning()
          if (!reasoning.decided) {
            reasoning.pending.push(reasoningDelta)
            yield* decideReasoning(false)
          } else {
            reasoning.text += reasoningDelta
            yield { type: 'reasoning-delta', index: reasoning.index, text: reasoningDelta }
          }
        }
        const contentDelta = typeof delta.content === 'string' ? delta.content : ''
        if (contentDelta.length > 0) {
          sawAny = true
          if (text === undefined) {
            text = { index: nextIndex++, text: '' }
            yield { type: 'block-start', index: text.index, blockType: 'text' }
          }
          text.text += contentDelta
          yield { type: 'text-delta', index: text.index, text: contentDelta }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (!isPlainObject(call)) continue
            const key = Number.isInteger(call.index) ? call.index : 0
            const name = isPlainObject(call.function) && typeof call.function.name === 'string'
              ? call.function.name
              : undefined
            const argumentsDelta = isPlainObject(call.function) && typeof call.function.arguments === 'string'
              ? call.function.arguments
              : ''
            let state = toolCalls.get(key)
            if (state === undefined) {
              const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : 'call_' + nextIndex
              state = { index: nextIndex++, id, name: name ?? '', args: '' }
              toolCalls.set(key, state)
              sawAny = true
              yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
              yield { type: 'tool-call-delta', index: state.index, id: state.id, name: state.name, argumentsDelta }
              state.args += argumentsDelta
            } else {
              if (name !== undefined && name.length > 0) state.name = name
              state.args += argumentsDelta
              yield { type: 'tool-call-delta', index: state.index, id: state.id, argumentsDelta }
            }
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        finishReason = choice.finish_reason
      }
    }
  }

  if (reasoning !== undefined && !reasoning.decided) yield* decideReasoning(true)
  if (finishReason === undefined) {
    throw new PrefixError('DeepSeek Beta 流在 finish_reason 之前结束', 'STREAM_CLOSED')
  }
  const finish = mapFinishReason(finishReason)
  if (!sawAny && finish.kind === 'stop') {
    throw new PrefixError('DeepSeek Beta 返回了空响应', 'EMPTY_RESPONSE')
  }

  const finished = []
  if (reasoning !== undefined) {
    finished.push({ index: reasoning.index, block: { type: 'reasoning', text: reasoning.text } })
  }
  if (text !== undefined) {
    finished.push({ index: text.index, block: { type: 'text', text: text.text } })
  }
  for (const state of toolCalls.values()) {
    finished.push({
      index: state.index,
      block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args },
    })
  }
  finished.sort((left, right) => left.index - right.index)
  for (const item of finished) {
    yield { type: 'block-end', index: item.index, block: item.block }
  }
  yield { type: 'usage', usage: usage ?? { inputTokens: 0, outputTokens: 0 } }
  yield { type: 'finish', reason: finish }
}
