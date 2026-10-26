/**
 * 设置里的模型/强度 → 子 agent `agentOptions` 的纯函数转换。
 *
 * 单独成文件是为了能在没有宿主依赖的测试环境里直接 import：`delegate.js`
 * 会静态 import `@deepseek-ai/dsh-tools`，而这里只做字符串解析。
 *
 * 约定：字段留空（空字符串或只有空白）= 继承父 agent，不传对应字段。
 *
 * @module zh-meow/route
 */

/**
 * 把设置里的 `model` / `effort` 转成子 agent 的 `agentOptions`。
 *
 * `model` 非空时必须写成 `provider/model`，按第一个 `/` 拆分；两个字段留空
 * 表示继承父 agent，返回 `undefined`（调用方就不传 `agentOptions`）。
 * @param {{ model?: string, effort?: string }} route - 设置里的模型与强度。
 * @returns 子 agent 的 `agentOptions`；完全继承时为 `undefined`。
 */
export function toAgentOptions(route) {
  const model = typeof route?.model === 'string' ? route.model.trim() : ''
  const effort = typeof route?.effort === 'string' ? route.effort.trim() : ''
  const options = {}
  if (model.length > 0) {
    const slash = model.indexOf('/')
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error(`模型要写成 provider/model（收到 "${model}"）；留空表示继承父 agent`)
    }
    options.provider = model.slice(0, slash)
    options.model = model.slice(slash + 1)
  }
  if (effort.length > 0) options.reasoningEffort = effort
  return Object.keys(options).length > 0 ? options : undefined
}
