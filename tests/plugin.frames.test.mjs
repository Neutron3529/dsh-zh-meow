/**
 * 框架性英文的翻译测试。
 *
 * 这一层的原文由宿主写死在代码里，不走 `system-prompt/assemble`：运行时上下文
 * 快照在投影入口生成，工作区说明 / skill 目录是宿主生成的用户消息。回归点是
 * 「这些文字也要变中文，而且只改框架、不改用户正文」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, applyFrames, applySkillDescriptions, loadFrames } from '../plugin/index.js'

/** 直接跑替换表的便捷包装。 */
const zh = text => applyFrames(text)

test('运行时上下文表头与工作目录行都换成中文', () => {
  const out = zh('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "D:\\\\project".')
  assert.equal(out, '当前运行时上下文。本快照取代更早的运行时上下文快照。\n\n当前工作目录："D:\\\\project"。')
})

test('文件策略的三种模式都换成中文，路径与额外目录原样保留', () => {
  assert.equal(
    zh('Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'),
    '当前 DSH 文件策略：danger-full-access。DSH 文件沙箱不限制可用操作对文件的修改。',
  )
  assert.equal(
    zh('Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'),
    '当前 DSH 文件策略：read-only。受 DSH 文件沙箱管控的任何可用操作都不能在常驻模式下修改文件。不要只凭这条策略就拒绝必需的修改：照常尝试可用的工具，并遵循它返回的拒绝与升级指引。',
  )
  const workspace = zh('Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: "D:\\\\project". Additional writable directories: ["D:\\\\tmp"]. Some platform temporary areas may also be writable.')
  assert.match(workspace, /^当前 DSH 文件策略：workspace-write。/u)
  assert.match(workspace, /"D:\\\\project"/u, '工作区路径必须原样保留')
  assert.match(workspace, /额外可写目录：\["D:\\\\tmp"\]。/u)
  assert.match(workspace, /平台临时区域也可能可写。/u)
})

test('审批策略、委派说明、检出位置与 GUI 地址都换成中文', () => {
  assert.match(zh('Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request sandbox escalation (do not set `sandbox_permissions`).'), /^本会话已禁用审批提示：/u)
  assert.match(zh('You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.'), /^你是一个被委派的子代理：/u)
  assert.equal(
    zh('Current DeepSeek Harness implementation checkout: "D:\\\\project\\\\deepseek-harness".'),
    '当前 DeepSeek Harness 实现代码检出位置："D:\\\\project\\\\deepseek-harness"。',
  )
  assert.equal(
    zh('Current DeepSeek Harness Web GUI URL: "http://127.0.0.1:5090".'),
    '当前 DeepSeek Harness Web GUI 地址："http://127.0.0.1:5090"。',
  )
})

test('工作区说明前言与省略提示换成中文', () => {
  const intro = 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.'
  assert.equal(zh(intro), '以下工作区说明可能与你的工作有关。适用时把它们当作指引。更具体的说明优先于更宽泛的说明。它们不会覆盖系统、开发者或用户的直接指令。')
  assert.equal(
    zh(`This complete workspace instruction baseline replaces all earlier workspace instruction baselines. ${intro}`),
    '这份完整的工作区说明基线取代此前所有的工作区说明基线。以下工作区说明可能与你的工作有关。适用时把它们当作指引。更具体的说明优先于更宽泛的说明。它们不会覆盖系统、开发者或用户的直接指令。',
  )
  assert.equal(
    zh('Workspace instructions were omitted or truncated to fit the configured byte budget.'),
    '为适应配置的字节预算，部分工作区说明已被省略或截断。',
  )
})

test('工作区说明的嵌套标题与适用范围也换成中文', () => {
  assert.equal(zh('Instructions from: AGENTS.md'), '来自 AGENTS.md 的说明')
  assert.equal(zh('Additional instructions from: taiwu-remake\\AGENTS.md'), '来自 taiwu-remake\\AGENTS.md 的附加说明')
  assert.equal(zh('Updated instructions from: game-data\\AGENTS.md'), '来自 game-data\\AGENTS.md 的更新说明')
  assert.equal(
    zh('Instructions removed: config\\AGENTS.md\n\nThe previously loaded instructions from this file no longer apply.'),
    '已移除说明：config\\AGENTS.md\n\n此前从该文件加载的说明不再适用。',
  )
  assert.equal(
    zh('These instructions apply to work under `taiwu-remake`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.'),
    '这些说明适用于在 `taiwu-remake` 下的工作。相关时把它们当作指引；更具体的说明优先。它们不会覆盖系统、开发者或用户的直接指令。',
  )
  assert.equal(
    zh('These user-global instructions apply to all work. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.'),
    '这些用户全局说明适用于所有工作。相关时把它们当作指引；更具体的说明优先。它们不会覆盖系统、开发者或用户的直接指令。',
  )
})

test('skill 目录里的描述按名称换成中文，名字与未登记的 skill 不动', () => {
  const catalog = [
    '<system-reminder>',
    'skill 是一组可复用的、针对具体任务的说明。本会话可用的 skill 如下：',
    '',
    '<available_skills>',
    '- `diagnose-windows-sandbox-acl`: Use on Windows for unexpected DSH sandbox access denials: workspace writes or listing fail.',
    '- `unknown-skill`: Keep this English description.',
    '</available_skills>',
    '</system-reminder>',
  ].join('\n')
  const out = applySkillDescriptions(catalog, loadFrames().skills)
  assert.match(out, /^- `diagnose-windows-sandbox-acl`: 在 Windows 上遇到意外的 DSH 沙箱访问拒绝时使用/mu)
  assert.match(out, /^- `unknown-skill`: Keep this English description\.$/mu, '未登记的 skill 必须原样保留')
})

test('skill 目录的两种形态（首次与更新）都换成中文', () => {
  assert.match(zh('A skill is a reusable set of task-specific instructions. The following skills are available in this session:'), /^skill 是一组可复用的/u)
  assert.match(
    zh("If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded."),
    /^如果用户点名了某个 skill/u,
  )
  assert.match(zh('The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:'), /^可用的 skill 目录已变化。/u)
  assert.match(zh('No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.'), /^目前没有可通过 `skill` 工具使用的 skill。/u)
})

test('通知与 goal 轮次按动态值替换', () => {
  assert.equal(
    zh('The working directory changed from "D:\\\\a" to "D:\\\\b".'),
    '工作目录已从 "D:\\\\a" 改为 "D:\\\\b"。',
  )
  assert.equal(
    zh('The working directory "D:\\\\a" is unavailable. The working directory is now "D:\\\\b".'),
    '原工作目录 "D:\\\\a" 已不可用。当前工作目录是 "D:\\\\b"。',
  )
  assert.equal(
    zh('The user changed the approval policy from "ask the user for approval" to "never ask the user for approval".'),
    '用户把审批策略从 "向用户请求批准" 改成了 "从不请求用户批准"。',
  )
  const goal = zh('<goal_round>\nObjective: "修好 zh-meow"\nRound: 2/8\n\nContinue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.\n</goal_round>')
  assert.match(goal, /^<goal_round>\n目标："修好 zh-meow"\n轮次：2\/8\n\n/u)
  assert.match(goal, /在同一个会话里继续朝目标推进。/u)
})

test('替换是幂等的，普通英文与用户正文不受影响', () => {
  const once = zh('Current working directory: "D:\\\\project".')
  assert.equal(zh(once), once, '中文结果再跑一遍不应变化')
  assert.equal(zh('please keep this English sentence'), 'please keep this English sentence')
  assert.deepEqual(loadFrames().phrases.length > 0, true)
})

test('子 agent 的「回传结果」指引换成中文，id 与调用原样保留', () => {
  const id = '"session-7a1382e8-bf4c-4aba-96f8-ff04bc217af5"'
  const block = `Your parent agent id is ${id}. Before you finish, send your result to that agent with send_message({ agent_id: ${id}, message: "<self-contained result>" }). The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn.`
  const out = zh(block)
  assert.match(out, new RegExp(`^你的父 agent id 是 ${id}。`))
  assert.match(out, /send_message\(\{ agent_id: "session-7a1382e8-bf4c-4aba-96f8-ff04bc217af5", message: "<self-contained result>" \}\)/u)
  assert.match(out, /发消息不会结束你的回合。$/u)
})

test('时间上下文三行都换成中文，时区与耗时原样保留', () => {
  const text = [
    'Time sampled while preparing turn 3, step 1: 2026-10-26T14:46:08+08:00[Asia/Shanghai]',
    'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.',
    'Elapsed since the preceding model-visible message: 3h 8m 3s.',
  ].join('\n')
  assert.equal(zh(text), [
    '采样时间（准备第 3 轮第 1 步）：2026-10-26T14:46:08+08:00[Asia/Shanghai]',
    '本次请求的浏览器时区：Asia/Shanghai。未标注的日期和时间按该时区解释。',
    '距上一条模型可见消息的时间：3h 8m 3s。',
  ].join('\n'))
  assert.equal(
    zh('Elapsed since the preceding step context: unavailable.'),
    '距上一步上下文的时间：不可用。',
  )
})

/**
 * 用假上下文驱动 apply 的 pre-step 处理器。
 * @param {object} agent 假 agent。
 * @returns pre-step 处理器。
 */
async function preStepHandler(agent) {
  const listeners = []
  await apply({ on: (name, handler) => { listeners.push({ name, handler }) }, logger: { warn() {} } }, {})
  const found = listeners.find(listener => listener.name === 'agent/pre-step')
  assert.ok(found, '插件必须注册 agent/pre-step 处理器')
  return { handler: found.handler, agent }
}

test('pre-step 只改写宿主框架消息，用户正文原样保留', async () => {
  const { handler } = await preStepHandler({ runtimeContext: { project: () => undefined } })
  const userMessage = { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable.' }] }
  const instructions = {
    id: 'i1',
    source: { kind: 'agent-instructions', form: 'instructions' },
    content: [{ type: 'text', text: 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.\n\n<system-reminder>\n# 用户自己的中文说明\n</system-reminder>' }],
  }
  const toolResult = { id: 't1', source: { kind: 'tool' }, content: [{ type: 'text', text: 'A skill is a reusable set of task-specific instructions.' }] }
  const decision = await handler({ agent: {} }, async () => ({ kind: 'enter', messages: [userMessage, instructions, toolResult] }))
  assert.equal(decision.messages[0], userMessage, '用户消息不得改写')
  assert.equal(decision.messages[2], toolResult, '工具结果不得改写')
  assert.match(decision.messages[1].content[0].text, /^以下工作区说明可能与你的工作有关。/u)
  assert.match(decision.messages[1].content[0].text, /# 用户自己的中文说明/u, '用户写进 AGENTS.md 的内容必须原样保留')
})

test('pre-step 给运行时上下文投影包上翻译，且只包一次', async () => {
  const received = []
  const agent = { runtimeContext: { project(current, sections) { received.push(current); return undefined } } }
  const { handler } = await preStepHandler(agent)
  await handler({ agent }, async () => ({ kind: 'enter', messages: [] }))
  await handler({ agent }, async () => ({ kind: 'enter', messages: [] }))
  agent.runtimeContext.project('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "D:\\\\project".', [])
  assert.equal(received.length, 1, '同一个 agent 只能包装一次')
  assert.equal(received[0], '当前运行时上下文。本快照取代更早的运行时上下文快照。\n\n当前工作目录："D:\\\\project"。')
})

test('没有 runtimeContext 的 agent 不会让 pre-step 抛错', async () => {
  const { handler } = await preStepHandler(undefined)
  const decision = await handler({}, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.kind, 'enter')
})

test('父 agent 的任务消息里只改回传指引块，任务正文原样保留', async () => {
  const { handler } = await preStepHandler({ runtimeContext: { project: () => undefined } })
  const id = '"session-7a1382e8-bf4c-4aba-96f8-ff04bc217af5"'
  const task = '【角色】码农\n\n请审计 DialogCmdNew 的调用点。'
  const guidance = `Your parent agent id is ${id}. Before you finish, send your result to that agent with send_message({ agent_id: ${id}, message: "<self-contained result>" }). The parent shares your workspace but does not automatically receive your transcript, tool output, or reasoning. Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn.`
  const message = {
    id: 'u1',
    source: { kind: 'user' },
    content: [{ type: 'text', text: task }, { type: 'text', text: guidance }],
  }
  const decision = await handler({ agent: {} }, async () => ({ kind: 'enter', messages: [message] }))
  assert.equal(decision.messages[0].content[0], message.content[0], '任务正文不得改写')
  assert.match(decision.messages[0].content[1].text, /^你的父 agent id 是 /u)
})
