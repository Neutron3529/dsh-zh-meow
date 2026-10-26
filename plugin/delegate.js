/**
 * 喵体中文的委派工具。
 *
 * 官方的 `@deepseek-ai/dsh-tool-subagent` 把子 agent 的模型与强度写死在插件
 * 配置里；本插件要按「设置 → 喵体中文」里的动态配置启动子 agent，所以自己
 * 注册这些工具，直接调用 `ctx.subagents.startActivation`，把配置里的
 * `model` / `effort` 转成子 agent 的 `agentOptions`。
 *
 * 配置语义（见 `team-config.js`）：
 *   - `model` 为空 = 继承父 agent 的 provider/model；
 *   - `effort` 为空 = 继承父 agent 的 reasoningEffort；
 *   - 两者都为空 = 完全继承。
 *
 * 三个工具各对应一个内部 preset：
 *   - `subagent_coder`    → `zh-meow-coder`，实现任务；
 *   - `subagent_verifier` → `zh-meow-verifier`，只读复核；
 *   - `subagent_probe`    → `zh-meow-probe`，验证某条路是否可行。探针有完整
 *     读写权限，但它的职责只到「这条路通不通」为止，所以工具会把角色与边界
 *     自动写进 prompt 开头，不依赖管家每次复制一遍。
 *
 * @module zh-meow/delegate
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { toAgentOptions } from './route.js'

/** Cordis 插件名。 */
export const name = 'zh-meow-delegate'

/** 本插件需要工具注册表与子 agent 服务。 */
export const inject = ['tools', 'subagents']

/** 设置服务不可用或某槽位缺失时使用的默认校验者。 */
const DEFAULT_VERIFIERS = [
  { id: 'v1', enabled: true, model: '', effort: 'high', mode: 'two-round' },
  { id: 'v2', enabled: true, model: '', effort: 'max', mode: 'one-shot' },
]

/** 码农的默认配置：模型继承、强度 low。 */
const DEFAULT_CODER = { model: '', effort: 'low' }

/**
 * 探针任务的固定前言。
 *
 * 探针有完整读写权限，唯一的边界是「只验证、不实现」。把这段写死在这里，比
 * 指望管家每次都把约束抄进 prompt 可靠：管家少写一句，探针就可能顺手把功能
 * 实现了，而任务相关文件一旦被动过，码农和校验者看到的就不是原状。
 */
const PROBE_PREAMBLE = `【角色】可行性探针

你的任务只有一个：验证管家给出的某条思路在真实环境里是否可行，然后把结论与证据交回来。

你有完整的读写与命令权限，但边界很窄：

- 只做验证，不实现功能，不改任务要改的源码、配置、文档与测试。
- 需要试写代码或试跑命令时，把实验文件放在 \`.meow-team/<task-id>/probe/\` 下，或放到系统临时目录；验证完自己删掉。
- 不提交 git，不 \`checkout\` / \`reset\` / \`clean\`，不改动已有分支状态。
- 验证前后各跑一次 \`git status --porcelain\`，确认自己没在仓库里留下改动；清理不掉就写进结论的「遗留」。
- 不联系主人，不再开子 agent。

回复要短：结论（可行 / 不可行 / 有前提）+ 证据（命令与关键输出、文件与行号）+ 置信度。不要把实现方案写成代码交回去。
`

/**
 * 注册两个委派工具。
 * @param ctx - 插件 context。
 */
export function apply(ctx) {
  const team = () => ctx.get('meowTeam')

  /**
   * 读取设置里的码农配置。
   * @returns `{ model, effort }`。
   */
  const coderRoute = () => {
    const service = team()
    if (service !== undefined && typeof service.coder === 'function') return service.coder()
    return DEFAULT_CODER
  }

  /**
   * 读取设置里启用的校验者槽位。
   * @returns 槽位数组。
   */
  const verifierRoutes = () => {
    const service = team()
    if (service !== undefined && typeof service.verifiers === 'function') {
      const rows = service.verifiers()
      if (Array.isArray(rows)) return rows
    }
    return DEFAULT_VERIFIERS.filter(verifier => verifier.enabled)
  }

  /**
   * 启动码农。
   * @param args - 工具参数。
   * @param exec - 工具执行上下文。
   * @returns 启动结果。
   */
  async function startCoder(args, exec) {
    const parent = exec.agent
    if (parent === undefined) throw new Error('subagent_coder 需要一个正在执行的 agent')
    const agentOptions = toAgentOptions(coderRoute())
    const maxDepth = ctx.subagents.resolveMaxDepth()
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: args.description,
      request: {
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        agentPreset: 'zh-meow-coder',
        ...agentOptions === undefined ? {} : { agentOptions },
        ...maxDepth === undefined ? {} : { maxDepth },
      },
      signal: exec.signal,
      delivery: 'parent',
    })
    return { kind: 'activation', subagentId: started.childId }
  }

  /**
   * 启动一个校验者槽位。
   * @param args - 工具参数（含 slot）。
   * @param exec - 工具执行上下文。
   * @returns 启动结果。
   */
  async function startVerifier(args, exec) {
    const parent = exec.agent
    if (parent === undefined) throw new Error('subagent_verifier 需要一个正在执行的 agent')
    const slot = verifierRoutes().find(verifier => verifier.id === args.slot)
    if (slot === undefined) {
      throw new Error(`没有找到启用的校验者槽位 "${args.slot}"，请到「设置 → 喵体中文」检查校验者列表`)
    }
    const agentOptions = toAgentOptions(slot)
    const maxDepth = ctx.subagents.resolveMaxDepth()
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: args.description,
      request: {
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        agentPreset: 'zh-meow-verifier',
        ...agentOptions === undefined ? {} : { agentOptions },
        ...maxDepth === undefined ? {} : { maxDepth },
      },
      signal: exec.signal,
      delivery: 'parent',
    })
    return { kind: 'activation', subagentId: started.childId }
  }

  /**
   * 启动一个可行性探针。
   *
   * 探针不读设置页：它继承本会话的模型与强度就够了。角色与硬约束由
   * `PROBE_PREAMBLE` 自动拼在 prompt 前面。
   * @param args - 工具参数。
   * @param exec - 工具执行上下文。
   * @returns 启动结果。
   */
  async function startProbe(args, exec) {
    const parent = exec.agent
    if (parent === undefined) throw new Error('subagent_probe 需要一个正在执行的 agent')
    const maxDepth = ctx.subagents.resolveMaxDepth()
    const started = await ctx.subagents.startActivation({
      provider: 'spawn',
      label: args.description,
      request: {
        ...args.cwd === undefined ? {} : { cwd: args.cwd },
        prompt: [{ type: 'text', text: `${PROBE_PREAMBLE}\n${args.prompt}` }],
        parent,
        agentPreset: 'zh-meow-probe',
        ...maxDepth === undefined ? {} : { maxDepth },
      },
      signal: exec.signal,
      delivery: 'parent',
    })
    return { kind: 'activation', subagentId: started.childId }
  }

  const coderTool = defineTool({
    name: 'subagent_coder',
    description:
      '启动一个码农子 agent（全新上下文、可继续对话）。它的模型与思考强度来自「设置 → 喵体中文」的码农配置；'
      + '配置留空表示继承本会话的模型与强度。prompt 必须自包含：写明【角色】码农、任务文件绝对路径、'
      + '要求它先读任务文件、必须自检、需要主人决定的问题通过 send_message 问你。',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: '对这次委派的简短描述（3-5 个词），只用于展示。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: '交给码农的完整任务；它看不到这条对话，要把角色、任务文件路径、自检要求都写进去。',
      },
      cwd: {
        type: 'string',
        description: '子 agent 的初始工作目录；省略则继承当前目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    execute: startCoder,
  })

  const verifierTool = defineTool({
    name: 'subagent_verifier',
    description:
      '启动一个独立校验者（全新上下文、可继续对话）。slot 是「设置 → 喵体中文」里启用的校验者槽位 id；'
      + '它的模型与思考强度来自该槽位配置，留空表示继承。同一轮里可以多次调用本工具，同时开启全部校验者。'
      + 'prompt 必须自包含：写明【角色】独立校验者、原版任务、任务文件路径、审核顺序，以及要求它只输出 '
      + 'PASS / FAILED / AMBIGUOUS 三态结论。',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: '对这次校验的简短描述（3-5 个词），只用于展示。',
      },
      slot: {
        type: 'string',
        required: true,
        description: '设置里启用的校验者槽位 id（例如 v1、v2）。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: '交给校验者的完整任务；它看不到这条对话，要把原版任务、任务文件路径、审核顺序都写进去。',
      },
      cwd: {
        type: 'string',
        description: '子 agent 的初始工作目录；省略则继承当前目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    execute: startVerifier,
  })

  const probeTool = defineTool({
    name: 'subagent_probe',
    description:
      '启动一个可行性探针（全新上下文、可继续对话）。它只回答「这条路到底行不行」：有完整的读写与命令权限，'
      + '但不实现功能、不改任务相关的文件，实验只放在 `.meow-team/<task-id>/probe/` 或系统临时目录。'
      + '角色与边界会自动拼进 prompt 开头，所以 prompt 里只要写清：在什么环境、验证什么、回来要什么证据。'
      + '一次只验一件事；不是常规路径，能自己用 read / grep 查清的事实不要开探针。',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: '对这次验证的简短描述（3-5 个词），只用于展示。',
      },
      prompt: {
        type: 'string',
        required: true,
        description: '要验证的问题；它看不到这条对话，要把环境、目标、期望的证据形式写进去。',
      },
      cwd: {
        type: 'string',
        description: '子 agent 的初始工作目录；省略则继承当前目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    execute: startProbe,
  })

  ctx.effect(() => {
    const disposeCoder = ctx.tools.register(coderTool)
    const disposeVerifier = ctx.tools.register(verifierTool)
    const disposeProbe = ctx.tools.register(probeTool)
    return () => {
      disposeCoder()
      disposeVerifier()
      disposeProbe()
    }
  }, 'zh-meow: delegate tools')
}
