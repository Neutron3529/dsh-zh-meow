/**
 * 喵体中文团队配置服务。
 *
 * 这个文件是 profile 顶层的一个普通插件条目（`meow-team-config`），它的
 * Config 会被 DSH 设置页当成可编辑命名空间。设置页的「喵体中文」分区通过
 * `ctx.configForms.get('meow-team-config')` 读写这里声明的 volatile 字段。
 *
 * 字段语义：
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

/** 插件配置 schema：volatile 字段才能在设置页即时编辑并立即生效。 */
export const Config = z.object({
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
