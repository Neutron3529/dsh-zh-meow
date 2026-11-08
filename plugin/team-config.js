/**
 * 喵体中文团队配置服务。
 *
 * 这个文件是 profile 顶层的一个普通插件条目（`meow-team-config`），它的
 * Config 会被 DSH 设置页当成可编辑命名空间。设置页的「喵体中文」分区通过
 * `ctx.configForms.get('meow-team-config')` 读写这里声明的 volatile 字段。
 *
 * 字段语义：
 *   - `ptc` 决定喵体中文用哪种工具执行器：`true`（默认）走 PTC 模式，模型写
 *     `run_code` 程序来调工具；`false` 走原生模式，模型直接逐个调工具。
 *     宿主没有挂 PTC runtime 时自动退回原生模式。
 *   - `mergeReadWrite` 决定 PTC 提示词里要不要那段「合并读写」指引：`true`（默认）
 *     会说明写文件撞上 `file changed since it was read` 时，就在同一个 `run_code`
 *     程序里重新读再写，别把读写拆成两次程序调用；`false` 则不出现这段文字。
 *     它只改提示词，不动执行器与 SDK 结构；原生模式本来就没有这个指引。
 *   - `model` 留空（空字符串）= 继承父 agent 的模型；否则写成 `provider/model`。
 *   - `effort` 留空 = 继承父 agent 的思考强度；否则是 `off` / `low` / `high` /
 *     `max`（或模型自己声明的值）。
 *   - `mode` 决定管家如何给校验者发任务：`two-round` 先只给原版任务、第二轮
 *     再给问答；`one-shot` 一次给全。
 *
 * 管家自己没有可写字段：它的模型与思考强度由 DSH 的会话模型选择器决定，
 * 子 agent 的「继承」就是继承管家当前的 route 与 effort。
 *
 * @module zh-meow/team-config
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_BASE_URL,
  DEFAULT_PREFIX_RULES,
  normalizeBaseURL,
  normalizePrefixRules,
} from './deepseek-prefix-core.js'

/** 默认校验者槽位：两个都继承模型，一个 high 两轮、一个 max 一次拿全。 */
const DEFAULT_VERIFIERS = [
  { id: 'v1', enabled: true, model: '', effort: 'high', mode: 'two-round' },
  { id: 'v2', enabled: true, model: '', effort: 'max', mode: 'one-shot' },
]

/** 单个校验者槽位。 */
const Verifier = z.object({
  id: z.string().required(),
  enabled: z.boolean().default(true),
  model: z.string().default(''),
  effort: z.string().default(''),
  mode: z.union(['two-round', 'one-shot']).default('one-shot'),
})

/** 单条 DeepSeek 前缀规则：role 是匹配条件，reasoning_content 是插入内容。 */
const PrefixRule = z.object({
  role: z.string().required(),
  reasoning_content: z.string().default(''),
})

/** 插件配置 schema：volatile 字段才能在设置页即时编辑并立即生效。 */
export const Config = z.object({
  ptc: z.boolean().default(true).volatile(),
  mergeReadWrite: z.boolean().default(true).volatile(),
  deepseekPrefix: z.boolean().default(false).volatile(),
  deepseekPrefixRules: z.array(PrefixRule).default(DEFAULT_PREFIX_RULES).volatile(),
  deepseekPrefixBaseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  coder: z.object({
    model: z.string().default(''),
    effort: z.string().default('low'),
  }).default({ model: '', effort: 'low' }).volatile(),
  verifiers: z.array(Verifier).default(DEFAULT_VERIFIERS).volatile(),
})

/**
 * 团队配置服务：给管家协议的动态段落与委派工具提供同一份配置快照。
 *
 * 每次读取都从 volatile 引用取值，因此设置页保存后下一轮组装就能看到新值，
 * 不需要重启宿主。
 */
export default class MeowTeamConfig extends Service {
  static Config = Config

  /**
   * @param ctx - 插件的 context。
   * @param config - 已解析的配置；字段是 volatile 引用。
   */
  constructor(ctx, config) {
    super(ctx, 'meowTeam')
    this.config = config
  }

  /**
   * 是否使用 PTC 模式（模型写 `run_code` 程序调工具）。
   *
   * 每次读取都取 volatile 引用，所以设置页保存后下一轮生效；宿主没有挂
   * PTC runtime 时由本地化插件自行降级，这里只表达「主人的意愿」。
   * @returns true 表示优先 PTC；false 表示明确要原生模式。
   */
  ptcMode() {
    return this.config.ptc.get() !== false
  }

  /**
   * 是否把「合并读写」指引写进 PTC 提示词。
   *
   * 开启时提示词会说明：写文件撞上 `file changed since it was read` 时，在同一个
   * `run_code` 程序里重新 `read` 再 `write`，不要把读写拆成两次程序调用——拆开会让
   * 读到的全文进入对话，白白多一次全量缓存重传。开关只影响提示词文字，不动执行器。
   * 每次读取都取 volatile 引用，所以设置页保存后下一轮生效。
   * @returns true 表示写进提示词；false 表示明确不要。
   */
  mergeReadWriteMode() {
    return this.config.mergeReadWrite.get() !== false
  }

  /**
   * DeepSeek 前缀续写配置。
   *
   * 规则数组是动态的：设置页可以按 role 增删，adapter 每次请求都重新读取。
   * 端点在这里尽量归一化；非法值保留原文，由 adapter 在请求时给出明确错误。
   * @returns {{ enabled: boolean, rules: object[], baseURL: string }} 当前配置。
   */
  deepseekPrefix() {
    const rawBaseURL = this.config.deepseekPrefixBaseURL.get()
    let baseURL
    try {
      baseURL = normalizeBaseURL(rawBaseURL)
    } catch {
      baseURL = typeof rawBaseURL === 'string' && rawBaseURL.trim().length > 0
        ? rawBaseURL.trim()
        : DEFAULT_BASE_URL
    }
    return {
      enabled: this.config.deepseekPrefix.get() === true,
      rules: normalizePrefixRules(this.config.deepseekPrefixRules.get()),
      baseURL,
    }
  }

  /**
   * 码农的模型与强度配置。
   * @returns `{ model, effort }`，空字符串表示继承。
   */
  coder() {
    const coder = this.config.coder.get()
    return { model: coder.model, effort: coder.effort }
  }

  /**
   * 当前启用的校验者槽位（保持设置页里的顺序）。
   * @returns 槽位数组；没有启用项时为空数组。
   */
  verifiers() {
    return this.config.verifiers.get().filter(verifier => verifier.enabled)
  }
}
