/**
 * DeepSeek 前缀续写（Beta）供应商。
 *
 * 这个文件是 profile 顶层的一个普通 Cordis 插件，不是 preset 作用域插件：
 *   - 总开关打开时，注册一个独立的 deepseek-beta 路由；
 *   - 关闭时注销这个路由，原版 deepseek-official 完全不受影响。
 *
 * 路由走 OpenAI 兼容的 /beta/chat/completions：DeepSeek 的对话前缀续写只在
 * 这个端点上开放。请求末尾会按配置的 role 规则插入一条 assistant 前缀消息，
 * 响应里的 reasoning 会接在发送前缀之后，保证下一轮请求能命中服务器缓存。
 *
 * @module zh-meow/deepseek-prefix
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_BASE_URL,
  PrefixError,
  buildChatRequest,
  normalizeBaseURL,
  normalizePrefixRules,
  parseSseStream,
  translateOpenAiStream,
} from './deepseek-prefix-core.js'

/** Cordis 插件名。 */
export const name = 'zh-meow-deepseek-prefix'

/** 需要 LLM 注册表与团队配置服务。 */
export const inject = ['llm', 'meowTeam']

/** 新供应商的路由名。 */
export const PROVIDER = 'deepseek-beta'

/** 供应商显示名。 */
export const DISPLAY_NAME = 'DeepSeek Beta（前缀续写）'

/** 复用现有 DeepSeek 供应商的凭据。 */
const API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 新路由公布的模型；id 必须与 DeepSeek API 的模型 id 一致。 */
export const MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1048576 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1048576 },
]

/**
 * 判断一个值是不是可当作字典用的普通对象。
 * @param {unknown} value 待判断的值。
 * @returns {boolean} 是否为非 null、非数组的对象。
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 按预设 Loader 的解析基准加载一个宿主包。
 *
 * 插件文件位于 bundle 目录，裸包名按 Node 默认规则解析不到 DSH 的安装位置。
 * 宿主启动时会安装一层运行期解析拦截，所以先直接 import；拦截没覆盖到时，
 * 再退回用声明该预设的 Loader 的 baseUrl 起一个 require。
 * @param {object} ctx 插件上下文，携带 baseUrl。
 * @param {string} specifier 包名。
 * @returns {object | undefined} 模块命名空间；两条路都失败时返回 undefined。
 */
async function importHostPackage(ctx, specifier) {
  try {
    return await import(specifier)
  } catch {
    // 落回下面的 baseUrl 解析。
  }
  const baseUrl = ctx.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined
  try {
    const require = createRequire(new URL('package.json', baseUrl))
    const resolved = require.resolve(specifier)
    return await import(pathToFileURL(resolved).href)
  } catch {
    return undefined
  }
}

/**
 * 从 meowTeam 服务读取当前前缀配置。
 * @param {object} ctx 插件上下文。
 * @returns {{ enabled: boolean, rules: object[], baseURL: string }} 归一化后的配置。
 */
function readSettings(ctx) {
  const service = typeof ctx?.get === 'function' ? ctx.get('meowTeam') : undefined
  let raw
  try {
    raw = typeof service?.deepseekPrefix === 'function' ? service.deepseekPrefix() : undefined
  } catch (error) {
    ctx?.logger?.warn?.('zh-meow-deepseek-prefix: 读取前缀配置失败', error)
    raw = undefined
  }
  return {
    enabled: raw?.enabled === true,
    rules: normalizePrefixRules(raw?.rules),
    baseURL: typeof raw?.baseURL === 'string' && raw.baseURL.length > 0 ? raw.baseURL : DEFAULT_BASE_URL,
  }
}

/**
 * 解析 DeepSeek API key。
 *
 * 依次尝试 credentials 服务与启动环境；都没有时抛 MISSING_CREDENTIAL。
 * @param {object} ctx 插件上下文。
 * @param {Function} LlmError 宿主错误类。
 * @returns {Promise<string>} 可用的 API key。
 */
async function resolveApiKey(ctx, LlmError) {
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const hit = await credentials.resolve(API_KEY_ENV)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.trim().length > 0) {
      return hit.value.trim()
    }
  }
  const ambient = typeof process === 'object' && process !== null && process.env !== undefined
    ? process.env[API_KEY_ENV]
    : undefined
  if (typeof ambient === 'string' && ambient.trim().length > 0) return ambient.trim()
  throw new LlmError('zh-meow-deepseek-prefix: 没有可用的 ' + API_KEY_ENV, 'MISSING_CREDENTIAL')
}

/**
 * 把 HTTP 状态码映射成宿主稳定错误码。
 * @param {number} status HTTP 状态码。
 * @returns {string} 错误码。
 */
function httpCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'QUOTA_EXCEEDED'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 422) return 'INVALID_REQUEST'
  if (status === 404) return 'NOT_FOUND'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER'
}

/**
 * 把非 2xx 响应转成 LlmError。
 * @param {Response} response fetch 响应。
 * @param {Function} LlmError 宿主错误类。
 * @returns {Promise<Error>} 可直接抛出的错误。
 */
async function httpError(response, LlmError) {
  let detail = ''
  try {
    const text = await response.text()
    if (typeof text === 'string' && text.length > 0) {
      detail = text
      try {
        const parsed = JSON.parse(text)
        if (isPlainObject(parsed) && isPlainObject(parsed.error) && typeof parsed.error.message === 'string') {
          detail = parsed.error.message
        } else if (isPlainObject(parsed) && typeof parsed.message === 'string') {
          detail = parsed.message
        }
      } catch {
        // 非 JSON 错误体保留原文。
      }
    }
  } catch {
    // 读不到错误体时只报状态码。
  }
  const suffix = detail.length > 0 ? '：' + detail.slice(0, 500) : ''
  return new LlmError(
    'DeepSeek Beta 请求失败（HTTP ' + String(response.status) + '）' + suffix,
    httpCode(response.status),
    { status: response.status },
  )
}

/**
 * 把核心模块的错误转成宿主错误。
 * @param {unknown} error 任意错误。
 * @param {Function} LlmError 宿主错误类。
 * @returns {Error} 宿主错误。
 */
function toLlmError(error, LlmError) {
  if (error instanceof LlmError) return error
  if (error instanceof PrefixError) return new LlmError(error.message, error.code, { cause: error })
  return new LlmError(
    error instanceof Error ? error.message : String(error),
    'INVALID_REQUEST',
    { cause: error },
  )
}

/**
 * 根据开关状态注册或注销 provider。
 *
 * 单独抽成纯函数，便于在没有宿主运行时的测试里覆盖生命周期。
 * @param {{ enabled: boolean, registration: unknown, register: () => unknown, dispose: (handle: unknown) => void, warn?: (error: unknown) => void }} options 当前状态与回调。
 * @returns {unknown} 更新后的注册句柄。
 */
export function applyRegistrationState(options) {
  const { enabled, registration, register, dispose, warn } = options
  if (enabled) {
    if (registration !== undefined) return registration
    try {
      return register()
    } catch (error) {
      warn?.(error)
      return undefined
    }
  }
  if (registration !== undefined) {
    try {
      dispose(registration)
    } catch (error) {
      warn?.(error)
    }
  }
  return undefined
}

/**
 * 创建 adapter 类。
 *
 * 依赖通过参数注入，测试可以传 fake 的 LlmAdapter / LlmError / fetch。
 * @param {{ LlmAdapter: Function, LlmError: Function, readSettings: () => object, resolveApiKey: () => Promise<string>, fetchImpl?: Function }} deps 依赖。
 * @returns {Function} 可交给 ctx.llm.registerAdapter 的 adapter 类。
 */
export function createAdapterClass(deps) {
  const {
    LlmAdapter,
    LlmError,
    readSettings: readAdapterSettings,
    resolveApiKey: resolveAdapterApiKey,
    fetchImpl = globalThis.fetch,
  } = deps

  return class DeepSeekBetaAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: DISPLAY_NAME }
    }

    async listModels(provider) {
      return MODELS.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: ['text'],
      }))
    }

    async resolveModel(provider, model) {
      const found = MODELS.find(item => item.id === model)
      return {
        provider,
        id: model,
        name: found === undefined ? model : found.name,
        inputModalities: ['text'],
        context: { contextWindow: found === undefined ? 1048576 : found.contextWindow },
        defaultMaxTokens: 65536,
        reasoning: {
          efforts: [
            { id: 'off', name: '关闭' },
            { id: 'low', name: 'low' },
            { id: 'high', name: 'high' },
            { id: 'max', name: 'max' },
          ],
          defaultEffort: 'high',
        },
        systemPromptUpdate: 'in-history',
      }
    }

    async *stream(options) {
      const settings = readAdapterSettings()
      let baseURL
      try {
        baseURL = normalizeBaseURL(settings.baseURL)
      } catch (error) {
        throw toLlmError(error, LlmError)
      }
      if (options.signal?.aborted === true) {
        throw new LlmError('DeepSeek Beta 请求已取消', 'ABORTED')
      }
      const apiKey = await resolveAdapterApiKey()
      const { body, prefix } = buildChatRequest(options, {
        enabled: settings.enabled,
        rules: settings.rules,
      })
      if (typeof fetchImpl !== 'function') {
        throw new LlmError('DeepSeek Beta 无法发起请求：fetch 不可用', 'TRANSPORT')
      }
      let response
      try {
        response = await fetchImpl(baseURL + '/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: 'Bearer ' + apiKey,
          },
          body: JSON.stringify(body),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw new LlmError('DeepSeek Beta 请求已取消', 'ABORTED', { cause: error })
        }
        throw new LlmError('DeepSeek Beta 传输失败', 'TRANSPORT', { cause: error })
      }
      if (response === undefined || response === null) {
        throw new LlmError('DeepSeek Beta 没有返回响应', 'TRANSPORT')
      }
      if (response.ok !== true) {
        throw await httpError(response, LlmError)
      }
      if (response.body === null || response.body === undefined) {
        throw new LlmError('DeepSeek Beta 没有返回响应体', 'EMPTY_RESPONSE')
      }
      try {
        yield* translateOpenAiStream(parseSseStream(response.body), { prefix: prefix?.text })
      } catch (error) {
        if (error instanceof LlmError) throw error
        if (error instanceof PrefixError) throw new LlmError(error.message, error.code, { cause: error })
        if (options.signal?.aborted === true) {
          throw new LlmError('DeepSeek Beta 请求已取消', 'ABORTED', { cause: error })
        }
        throw new LlmError('DeepSeek Beta 流处理失败', 'TRANSPORT', { cause: error })
      }
    }
  }
}

/**
 * 应用本插件。
 * @param {object} ctx 顶层插件上下文。
 * @returns {Promise<void>} 安装完成的 Promise。
 */
export async function apply(ctx) {
  ctx.logger?.info?.('zh-meow-deepseek-prefix: 插件已加载')
  const host = await importHostPackage(ctx, '@deepseek-ai/dsh-llm')
  if (host === undefined
    || typeof host.LlmAdapter !== 'function'
    || typeof host.LlmError !== 'function') {
    ctx.logger?.warn?.('zh-meow-deepseek-prefix: 无法加载 @deepseek-ai/dsh-llm，前缀供应商不注册')
    return
  }

  const Adapter = createAdapterClass({
    LlmAdapter: host.LlmAdapter,
    LlmError: host.LlmError,
    readSettings: () => readSettings(ctx),
    resolveApiKey: () => resolveApiKey(ctx, host.LlmError),
  })

  let registration
  let lastWarning = ''
  const warn = (error) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message === lastWarning) return
    lastWarning = message
    ctx.logger?.warn?.('zh-meow-deepseek-prefix: 注册或注销 deepseek-beta 失败', error)
  }

  const sync = () => {
    const settings = readSettings(ctx)
    const previous = registration
    ctx.logger?.info?.('zh-meow-deepseek-prefix: 前缀开关' + (settings.enabled ? '开启' : '关闭'))
    registration = applyRegistrationState({
      enabled: settings.enabled,
      registration,
      register: () => ctx.llm.registerAdapter([PROVIDER], new Adapter()),
      dispose: handle => handle(),
      warn,
    })
    if (previous === undefined && registration !== undefined) {
      lastWarning = ''
      ctx.logger?.info?.('zh-meow-deepseek-prefix: 已注册 ' + PROVIDER + ' 供应商')
    } else if (previous !== undefined && registration === undefined) {
      ctx.logger?.info?.('zh-meow-deepseek-prefix: 已注销 ' + PROVIDER + ' 供应商')
    }
  }

  ctx.effect(() => () => {
    if (registration !== undefined) {
      try {
        registration()
      } catch (error) {
        ctx.logger?.warn?.('zh-meow-deepseek-prefix: 注销 adapter 失败', error)
      }
      registration = undefined
    }
  }, 'zh-meow-deepseek-prefix: adapter')

  sync()
  ctx.on('loader/volatile-update', sync)
  ctx.on('settings/document-updated', (namespace) => {
    if (namespace === 'meow-team-config') sync()
  })
}
