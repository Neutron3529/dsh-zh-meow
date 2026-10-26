/**
 * 管家收尾用的清理工具。
 *
 * 管家没有 shell，而「收尾时清掉本次任务的临时产物」需要一个删除动作，所以
 * 这里注册一个窄工具 `meow_cleanup`。它只删两类东西：
 *   - `.meow-team/<task-id>/` 这个任务目录（`keep` 可保留其中若干文件）；
 *   - 调用方显式列出的工作区临时路径（`extraPaths`，拒绝 `.git` 与被版本
 *     控制跟踪的文件）。
 *
 * 为什么不给管家 `pwsh` / `bash`：命令工具没有任何路径约束，等于把「删任何
 * 东西」的能力交给一个不该动手的对话角色。窄工具的每次删除都落在可枚举的
 * 清单里，汇报时能逐条给主人看，`dryRun` 还能先预览。
 *
 * 路径解析与删除逻辑在 `cleanup-core.js`：那里不 import DSH 包，测试可以直接
 * 覆盖；本文件只负责取工作区根、注册工具、渲染结果。
 *
 * @module zh-meow/cleanup
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { runCleanup } from './cleanup-core.js'

/** Cordis 插件名。 */
export const name = 'zh-meow-cleanup'

/** 本插件需要工具注册表与工作目录服务。 */
export const inject = ['tools', 'workingDirectory']

/**
 * 注册 `meow_cleanup`。
 * @param ctx 插件 context。
 * @returns 无。
 */
export function apply(ctx) {
  /**
   * 执行一次清理。
   * @param args 工具参数。
   * @param exec 工具执行上下文。
   * @returns 删除清单。
   */
  async function cleanup(args, exec) {
    if (exec.agent === undefined) throw new Error('meow_cleanup 需要一个正在执行的 agent')
    const root = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    return runCleanup({
      root,
      taskId: typeof args.taskId === 'string' ? args.taskId.trim() : undefined,
      extraPaths: Array.isArray(args.extraPaths) ? args.extraPaths : [],
      keep: args.keep,
      dryRun: args.dryRun === true,
    })
  }

  const tool = defineTool({
    name: 'meow_cleanup',
    description:
      '收尾清理：删除本次任务留下的临时产物。`taskId` 删除 `.meow-team/<task-id>/` 整个目录'
      + '（`keep` 可保留其中若干文件）；`extraPaths` 清理任务目录之外的临时路径，'
      + '被版本控制跟踪的路径会被拒绝。先带 `dryRun: true` 看清单，确认无误再真删。'
      + '只删本次任务的东西：别的任务目录、项目源码、git 状态都不动。',
    parameters: {
      taskId: {
        type: 'string',
        description: '本次任务目录名，例如 0003-fix-null-ref；省略表示只清理 extraPaths。',
      },
      extraPaths: {
        type: 'array',
        items: { type: 'string' },
        description: '任务目录之外的临时路径（相对工作区或绝对路径）；必须在工作区内且未被 git 跟踪。',
      },
      keep: {
        type: 'array',
        items: { type: 'string' },
        description: '相对任务目录的路径，命中者保留不删（例如 ["01-task.md", "20-handoff-1.md"]）。',
      },
      dryRun: {
        type: 'boolean',
        description: '只列出将删除的清单，不真删。默认 false。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'cleanup' },
          dryRun: { type: 'boolean', required: true },
          entries: { type: 'array', required: true, items: { type: 'string' } },
          kept: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [value.dryRun
          ? `dry run：将删除 ${value.entries.length} 个文件`
          : `已删除 ${value.entries.length} 个文件`]
        for (const entry of value.entries.slice(0, 80)) lines.push(`- ${entry}`)
        if (value.entries.length > 80) lines.push(`- ……另有 ${value.entries.length - 80} 个`)
        if (value.kept.length > 0) {
          lines.push(`保留了 ${value.kept.length} 个文件：`)
          for (const entry of value.kept.slice(0, 40)) lines.push(`- ${entry}`)
          if (value.kept.length > 40) lines.push(`- ……另有 ${value.kept.length - 40} 个`)
        }
        for (const note of value.notes) lines.push(`注意：${note}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    execute: cleanup,
  })

  ctx.effect(() => {
    const dispose = ctx.tools.register(tool)
    return () => dispose()
  }, 'zh-meow: cleanup tool')
}
