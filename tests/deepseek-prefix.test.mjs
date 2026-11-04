/**
 * DeepSeek 前缀续写的纯逻辑与 adapter 测试。
 *
 * 这些测试不依赖 DSH 运行时：核心模块零依赖，adapter 的 LlmAdapter / LlmError
 * 与 fetch 都通过参数注入。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_BASE_URL,
  DEFAULT_PREFIX_RULES,
  PrefixError,
  blocksToText,
  buildChatRequest,
  createSseParser,
  mapFinishReason,
  mapUsage,
  normalizeBaseURL,
  normalizePrefixRules,
  parseSseStream,
  selectPrefix,
  toChatMessages,
  translateOpenAiStream,
} from '../plugin/deepseek-prefix-core.js'

import {
  MODELS,
  applyRegistrationState,
  createAdapterClass,
} from '../plugin/deepseek-prefix.js'

/** 把异步迭代器收成数组。 */
async function collect(iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

/** 把数组包成异步迭代器。 */
async function* eventsFrom(items) {
  for (const item of items) yield item
}

/** 用一段文本或 Uint8Array 列表模拟 fetch 响应体。 */
function bodyFrom(chunks) {
  let index = 0
  const encoder = new TextEncoder()
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined }
          const chunk = chunks[index++]
          return { done: false, value: typeof chunk === 'string' ? encoder.encode(chunk) : chunk }
        },
        releaseLock() {},
      }
    },
  }
}

/** 模拟 fetch 响应。 */
function responseFromChunks(chunks, init = {}) {
  return {
    ok: init.ok === undefined ? true : init.ok,
    status: init.status === undefined ? 200 : init.status,
    body: init.body === null ? null : bodyFrom(chunks),
    text: async () => (init.text === undefined ? '' : init.text),
  }
}

/** 一条最小的 DSH 请求。 */
function baseOptions(extra = {}) {
  return {
    provider: 'deepseek-beta',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    reasoningEffort: 'high',
    ...extra,
  }
}

/** 用 fake 依赖造一个 adapter 实例。 */
function makeAdapter({ settings, key = 'sk-test', fetchImpl }) {
  const Adapter = createAdapterClass({
    LlmAdapter: class FakeLlmAdapter {},
    LlmError: FakeLlmError,
    readSettings: () => settings,
    resolveApiKey: async () => {
      if (key === null) throw new FakeLlmError('没有 key', 'MISSING_CREDENTIAL')
      return key
    },
    fetchImpl,
  })
  return new Adapter()
}

/** fake 的宿主 LlmError。 */
class FakeLlmError extends Error {
  constructor(message, code, options = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.failure = {
      message,
      code,
      ...(options.status === undefined ? {} : { status: options.status }),
    }
  }
}

test('normalizePrefixRules 过滤坏条目并保留顺序', () => {
  assert.deepEqual(normalizePrefixRules(undefined), DEFAULT_PREFIX_RULES)
  assert.deepEqual(normalizePrefixRules(null), DEFAULT_PREFIX_RULES)
  assert.deepEqual(normalizePrefixRules('bad'), DEFAULT_PREFIX_RULES)
  assert.deepEqual(normalizePrefixRules([]), [])
  assert.deepEqual(normalizePrefixRules([
    { role: ' user ', reasoning_content: 'a' },
    { role: '', reasoning_content: 'b' },
    null,
    { role: 'tool' },
    { role: 'system', reasoning_content: 42 },
  ]), [
    { role: 'user', reasoning_content: 'a' },
    { role: 'tool', reasoning_content: '' },
    { role: 'system', reasoning_content: '' },
  ])
})

test('normalizeBaseURL 去尾斜杠、回退默认并拒绝非法地址', () => {
  assert.equal(normalizeBaseURL(undefined), DEFAULT_BASE_URL)
  assert.equal(normalizeBaseURL(''), DEFAULT_BASE_URL)
  assert.equal(normalizeBaseURL('https://api.deepseek.com/beta/'), 'https://api.deepseek.com/beta')
  assert.throws(() => normalizeBaseURL('not a url'), PrefixError)
  assert.throws(() => normalizeBaseURL('ftp://example.com/beta'), PrefixError)
  assert.throws(() => normalizeBaseURL('https://user:pass@example.com/beta'), PrefixError)
  assert.throws(() => normalizeBaseURL('https://example.com/beta?x=1'), PrefixError)
})

test('selectPrefix 按最后一条消息的 role 匹配动态规则', () => {
  const user = [{ role: 'user', content: [] }]
  const tool = [{ role: 'tool', content: [] }]
  assert.deepEqual(selectPrefix(user), { matchedRole: 'user', text: '让我想想喵~' })
  assert.deepEqual(selectPrefix(tool), { matchedRole: 'tool', text: '让我看看喵~' })
  assert.equal(selectPrefix([{ role: 'assistant', content: [] }]), undefined)
  assert.equal(selectPrefix([]), undefined)
  assert.equal(selectPrefix(user, { enabled: false }), undefined)
  assert.equal(selectPrefix(user, { thinking: false }), undefined)

  const custom = [{ role: 'system', reasoning_content: '系统前缀' }]
  assert.deepEqual(selectPrefix([{ role: 'system' }], { rules: custom }), {
    matchedRole: 'system',
    text: '系统前缀',
  })

  const duplicate = [
    { role: 'user', reasoning_content: '' },
    { role: 'user', reasoning_content: '后面的规则' },
  ]
  assert.equal(selectPrefix(user, { rules: duplicate }), undefined)
})

test('toChatMessages 合并 system/developer、保留 reasoning 与工具调用', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'sys1' }] },
    {
      role: 'developer',
      content: [
        { type: 'tool-addition', toolName: 'read' },
        { type: 'text', text: 'dev' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"a":1}' },
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'result' }] },
    { role: 'assistant', content: [] },
  ]
  assert.deepEqual(toChatMessages(messages), [
    { role: 'system', content: 'sys1\n\ndev' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'think',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"a":1}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ])
})

test('blocksToText 为图片与文件保留占位符', () => {
  assert.equal(blocksToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'file' }]), 'a[image][file]')
  assert.equal(blocksToText('plain'), 'plain')
  assert.equal(blocksToText(undefined), '')
})

test('buildChatRequest 在无工具请求末尾插入动态 role 前缀', () => {
  const { body, prefix, suppressed } = buildChatRequest(baseOptions({
    maxTokens: 1024,
    stop: ['STOP'],
  }), { enabled: true, rules: DEFAULT_PREFIX_RULES })
  assert.equal(body.model, 'deepseek-flash')
  assert.equal(body.stream, true)
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.max_tokens, 1024)
  assert.deepEqual(body.stop, ['STOP'])
  assert.equal('tools' in body, false)
  assert.equal(suppressed, undefined)
  assert.deepEqual(prefix, { matchedRole: 'user', text: '让我想想喵~' })
  assert.deepEqual(body.messages.at(-1), {
    role: 'assistant',
    content: '',
    reasoning_content: '让我想想喵~',
    prefix: true,
  })
})

test('buildChatRequest 在带工具请求中跳过前缀，避免 Function call 400', () => {
  const { body, prefix, suppressed } = buildChatRequest(baseOptions({
    tools: [{ name: 'read', description: '读文件', parameters: { type: 'object' } }],
  }), { enabled: true, rules: DEFAULT_PREFIX_RULES })
  assert.deepEqual(body.tools, [{
    type: 'function',
    function: { name: 'read', description: '读文件', parameters: { type: 'object' } },
  }])
  assert.equal(prefix, undefined)
  assert.equal(suppressed, 'tools')
  assert.equal(body.messages.some(message => message.prefix === true), false)
  assert.equal(body.messages.at(-1).role, 'user')
})

test('buildChatRequest 只在工具列表非空时跳过前缀', () => {
  const { prefix, suppressed, body } = buildChatRequest(baseOptions({ tools: [] }), {
    enabled: true,
    rules: DEFAULT_PREFIX_RULES,
  })
  assert.equal(suppressed, undefined)
  assert.deepEqual(prefix, { matchedRole: 'user', text: '让我想想喵~' })
  assert.equal('tools' in body, false)
})

test('buildChatRequest 支持 tool、自定义 role 与关闭思考', () => {
  const toolBody = buildChatRequest({
    provider: 'deepseek-beta',
    model: 'deepseek-flash',
    messages: [{ role: 'tool', content: [{ type: 'text', text: 'result' }], toolCallId: 'c1' }],
    reasoningEffort: 'max',
  }, { enabled: true, rules: DEFAULT_PREFIX_RULES }).body
  assert.equal(toolBody.messages.at(-1).reasoning_content, '让我看看喵~')
  assert.equal(toolBody.reasoning_effort, 'max')

  const custom = buildChatRequest({
    provider: 'deepseek-beta',
    model: 'deepseek-flash',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }],
    reasoningEffort: 'low',
  }, {
    enabled: true,
    rules: [{ role: 'system', reasoning_content: '系统前缀' }],
  })
  assert.equal(custom.body.messages.at(-1).reasoning_content, '系统前缀')

  const off = buildChatRequest(baseOptions({ reasoningEffort: 'off' }), { enabled: true })
  assert.deepEqual(off.body.thinking, { type: 'disabled' })
  assert.equal('reasoning_effort' in off.body, false)
  assert.equal(off.prefix, undefined)
  assert.equal(off.body.messages.at(-1).role, 'user')

  const disabled = buildChatRequest(baseOptions(), { enabled: false })
  assert.equal(disabled.prefix, undefined)
  assert.equal(disabled.body.messages.at(-1).role, 'user')
})

test('createSseParser 支持跨 chunk、多行 data 与 CRLF', () => {
  const parser = createSseParser()
  assert.deepEqual(parser.push('data: {"a":'), [])
  assert.deepEqual(parser.push('1}\r\n\r\n'), ['{"a":1}'])
  assert.deepEqual(parser.push('data: line1\ndata: line2\n\n'), ['line1\nline2'])
  assert.deepEqual(parser.push('data: tail'), [])
  assert.deepEqual(parser.end(), ['tail'])
})

test('parseSseStream 跨多字节字符并停在 [DONE]', async () => {
  const payload = 'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\ndata: [DONE]\n\n'
  const encoder = new TextEncoder()
  const bytes = encoder.encode(payload)
  const charIndex = payload.indexOf('你')
  const headLength = encoder.encode(payload.slice(0, charIndex)).length
  const events = await collect(parseSseStream(bodyFrom([bytes.slice(0, headLength + 1), bytes.slice(headLength + 1)])))
  assert.equal(events.length, 1)
  assert.equal(events[0].choices[0].delta.content, '你')
})

test('parseSseStream 拒绝坏 JSON 与缺失 body', async () => {
  await assert.rejects(
    collect(parseSseStream(bodyFrom(['data: nope\n\n']))),
    error => error instanceof PrefixError && error.code === 'MALFORMED_RESPONSE',
  )
  await assert.rejects(
    collect(parseSseStream(null)),
    error => error instanceof PrefixError && error.code === 'TRANSPORT',
  )
})

test('mapUsage 把缓存命中从输入 token 中拆出来', () => {
  assert.deepEqual(mapUsage({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_cache_hit_tokens: 4,
    completion_tokens_details: { reasoning_tokens: 2 },
  }), {
    inputTokens: 6,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 4,
    reasoningTokens: 2,
  })
  assert.deepEqual(mapUsage({ prompt_tokens: 3, prompt_cache_hit_tokens: 9 }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 3,
  })
  assert.deepEqual(mapUsage(undefined), { inputTokens: 0, outputTokens: 0 })
})

test('mapFinishReason 覆盖成功、限长与错误状态', () => {
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
  assert.equal(mapFinishReason('content_filter').failure.code, 'CONTENT_FILTER')
  assert.equal(mapFinishReason('aborted').kind, 'aborted')
  assert.equal(mapFinishReason('bogus').failure.code, 'MALFORMED_RESPONSE')
})

test('translateOpenAiStream 把前缀接在增量 reasoning 之前', async () => {
  const chunks = await collect(translateOpenAiStream(eventsFrom([
    { choices: [{ index: 0, delta: { reasoning_content: '主人的任务' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: '很困难呢' } }] },
    { choices: [{ index: 0, delta: { content: '我需要看一看' } }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4 },
    },
  ]), { prefix: '让我想想喵~' }))
  const reasoningEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoningEnd.block.text, '让我想想喵~主人的任务很困难呢')
  const textEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
  assert.equal(textEnd.block.text, '我需要看一看')
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 6, outputTokens: 5, cacheReadTokens: 4 })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('translateOpenAiStream 对完整 reasoning 去重', async () => {
  const chunks = await collect(translateOpenAiStream(eventsFrom([
    { choices: [{ index: 0, delta: { reasoning_content: '让我想想喵~主人很难' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: '过' } }] },
    { choices: [{ index: 0, delta: { content: '好' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]), { prefix: '让我想想喵~' }))
  const reasoningEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoningEnd.block.text, '让我想想喵~主人很难过')
})

test('translateOpenAiStream 组装流式 tool calls', async () => {
  const chunks = await collect(translateOpenAiStream(eventsFrom([
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_a',
            type: 'function',
            function: { name: 'read', arguments: '{"a"' },
          }],
        },
      }],
    },
    {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] },
      }],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]), {}))
  const toolStart = chunks.find(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')
  assert.ok(toolStart)
  const toolEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(toolEnd.block, { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"a":1}' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('translateOpenAiStream 拒绝未完成与空响应', async () => {
  await assert.rejects(
    collect(translateOpenAiStream(eventsFrom([
      { choices: [{ index: 0, delta: { content: 'x' } }] },
    ]), {})),
    error => error instanceof PrefixError && error.code === 'STREAM_CLOSED',
  )
  await assert.rejects(
    collect(translateOpenAiStream(eventsFrom([
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]), {})),
    error => error instanceof PrefixError && error.code === 'EMPTY_RESPONSE',
  )
})

test('createAdapterClass 发出正确的请求并转换响应', async () => {
  let captured
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"想"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"一想"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"好"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_cache_hit_tokens":4}}\n\n',
    'data: [DONE]\n\n',
  ]
  const adapter = makeAdapter({
    settings: { enabled: true, rules: DEFAULT_PREFIX_RULES, baseURL: 'https://api.deepseek.com/beta' },
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return responseFromChunks(sse)
    },
  })
  const chunks = await collect(adapter.stream(baseOptions()))
  assert.equal(captured.url, 'https://api.deepseek.com/beta/chat/completions')
  assert.equal(captured.init.method, 'POST')
  assert.equal(captured.init.headers.authorization, 'Bearer sk-test')
  assert.equal(captured.init.headers.accept, 'text/event-stream')
  const body = JSON.parse(captured.init.body)
  assert.deepEqual(body.messages.at(-1), {
    role: 'assistant',
    content: '',
    reasoning_content: '让我想想喵~',
    prefix: true,
  })
  const reasoningEnd = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
  assert.equal(reasoningEnd.block.text, '让我想想喵~想一想')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(chunks.at(-1).reason.kind, 'stop')
})

test('createAdapterClass 处理缺失 key、HTTP 错误与非法端点', async () => {
  const settings = { enabled: true, rules: DEFAULT_PREFIX_RULES, baseURL: 'https://api.deepseek.com/beta' }
  await assert.rejects(
    collect(makeAdapter({ settings, key: null, fetchImpl: async () => responseFromChunks([]) }).stream(baseOptions())),
    error => error.code === 'MISSING_CREDENTIAL',
  )
  await assert.rejects(
    collect(makeAdapter({
      settings,
      fetchImpl: async () => responseFromChunks([], {
        ok: false,
        status: 401,
        text: '{"error":{"message":"bad key"}}',
      }),
    }).stream(baseOptions())),
    error => error.code === 'AUTH' && error.message.includes('bad key'),
  )
  await assert.rejects(
    collect(makeAdapter({
      settings: { ...settings, baseURL: 'ftp://example.com' },
      fetchImpl: async () => responseFromChunks([]),
    }).stream(baseOptions())),
    error => error.code === 'INVALID_REQUEST',
  )
})

test('applyRegistrationState 只在开关变化时注册或注销', () => {
  let registered = 0
  let disposed = 0
  const handle = () => { disposed += 1 }
  const first = applyRegistrationState({
    enabled: true,
    registration: undefined,
    register: () => { registered += 1; return handle },
    dispose: value => value(),
  })
  assert.equal(first, handle)
  assert.equal(registered, 1)

  const again = applyRegistrationState({
    enabled: true,
    registration: first,
    register: () => { registered += 1; return handle },
    dispose: value => value(),
  })
  assert.equal(again, handle)
  assert.equal(registered, 1)

  const off = applyRegistrationState({
    enabled: false,
    registration: again,
    register: () => handle,
    dispose: value => value(),
  })
  assert.equal(off, undefined)
  assert.equal(disposed, 1)
})

test('applyRegistrationState 捕获注册与注销失败', () => {
  let warned
  const failed = applyRegistrationState({
    enabled: true,
    registration: undefined,
    register: () => { throw new Error('boom') },
    dispose: () => {},
    warn: error => { warned = error },
  })
  assert.equal(failed, undefined)
  assert.equal(warned.message, 'boom')

  warned = undefined
  const off = applyRegistrationState({
    enabled: false,
    registration: () => { throw new Error('dispose boom') },
    register: () => undefined,
    dispose: value => value(),
    warn: error => { warned = error },
  })
  assert.equal(off, undefined)
  assert.equal(warned.message, 'dispose boom')
})

test('模型目录包含两个官方模型', () => {
  assert.deepEqual(MODELS.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
})
