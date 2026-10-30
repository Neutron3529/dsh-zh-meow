/**
 * PTC 模式（`run_code` 编程调工具）的本地化与模式切换测试。
 *
 * 这些测试不依赖 DSH 运行时：DSH 的执行器与 SDK 渲染器都按接口 mock，重点
 * 锁定三件事：
 *   1. 设置页开关是唯一的模式来源，默认开启，缺 PTC runtime 时自动退回原生；
 *   2. `run_code` 与生成的 SDK 都是中文，且结构字段（type/enum/required）不动；
 *   3. 两种模式共用一个执行器实例，切换不需要重装。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createModeExecutor,
  loadPtcTable,
  loadTranslations,
  renderLocalizedSdk,
  resolveExecutorMode,
  translatePtcSchema,
} from '../plugin/index.js'

/** 真实的 PTC 替换表。 */
const ptcTable = loadPtcTable()

/** 按英文片段取一条替换规则，避免依赖 `phrases` 的数组顺序。 */
const phraseFor = fragment => {
  const rule = ptcTable.phrases.find(entry => entry.en.includes(fragment))
  assert.ok(rule, `data/ptc.json 缺少包含 ${fragment} 的规则`)
  return rule
}

/** 一份带完整参数与提权文案的 `run_code` schema，取自上游真实拼装结果。 */
const runCodeSchema = {
  name: 'run_code',
  description: phraseFor('the BODY of an async function').en,
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', required: true, description: 'The program: the body of an async TypeScript function.' },
      description: { type: 'string', required: true, description: phraseFor('Clear, concise description').en },
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'], description: 'Wider sandbox mode for this complete program execution; requires justification and approval.' },
    },
    required: ['code', 'description'],
  },
}

/** 一个注册表可见的工具定义。 */
const bashDefinition = {
  name: 'bash',
  description: 'Run a bash command and return its stdout/stderr.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The command to run.' } },
    required: ['command'],
  },
  output: { schema: { type: 'string' } },
}

test('PTC 替换表包含唯一工具规则、run_code 文案与超时数字规则', () => {
  assert.equal(typeof ptcTable.ptcOnly, 'string')
  assert.match(ptcTable.ptcOnly, /run_code/)
  assert.match(ptcTable.ptcOnly, /唯一/)
  assert.ok(ptcTable.phrases.length >= 20, 'PTC 文案应覆盖 run_code、SDK 说明与提权指引')
  assert.ok(ptcTable.patterns.some(rule => rule.regex.test('Positive elapsed-time budget in milliseconds, including nested tool and approval waits. Default 120000; capped at 600000. Zero does not disable the deadline.')),
    '超时描述带动态默认值与上限，必须用正则规则')
})

test('ptc.json 不会被当成段落/工具译文读进普通译文表', () => {
  const { sections, tools } = loadTranslations()
  assert.equal(sections.ptcOnly, undefined, 'ptc.json 的顶层字段不应混进段落译文')
  assert.equal(tools.phrases, undefined, 'ptc.json 的替换规则不应混进工具译文')
})

test('translatePtcSchema 把 run_code 描述与参数描述换成中文，结构字段不动', () => {
  const translated = translatePtcSchema(runCodeSchema, ptcTable)
  assert.notEqual(translated.description, runCodeSchema.description)
  assert.match(translated.description, /执行一段 TypeScript 程序/)
  assert.match(translated.parameters.properties.code.description, /async TypeScript 函数的主体/)
  assert.match(translated.parameters.properties.description.description, /主动语态/)
  assert.match(translated.parameters.properties.sandbox_permissions.description, /更宽 sandbox 模式/)
  assert.deepEqual(translated.parameters.properties.sandbox_permissions.enum, ['workspace-write', 'danger-full-access'], '枚举取值必须原样保留')
  assert.equal(translated.parameters.properties.code.required, true, 'required 必须原样保留')
  assert.equal(translated.name, 'run_code')
})

test('translatePtcSchema 对没有命中译文的描述保持原文', () => {
  const schema = { name: 'run_code', description: 'Keep me.', parameters: { type: 'object', properties: { code: { type: 'string', description: 'Keep me too.' } } } }
  const translated = translatePtcSchema(schema, ptcTable)
  assert.equal(translated.description, 'Keep me.')
  assert.equal(translated.parameters.properties.code.description, 'Keep me too.')
  assert.equal(translated, schema, '无改动时不应新建对象')
})

test('renderLocalizedSdk 翻译工具描述与固定说明，并报告漏翻工具', () => {
  const reported = []
  const sdk = renderLocalizedSdk([bashDefinition, { ...bashDefinition, name: 'unknown_tool', description: 'Unknown tool.' }], {
    // 用假的渲染器模拟上游格式：工具描述与一条固定英文说明。
    render: schemas => [
      '## Writing code for run_code',
      ...schemas.map(schema => `- ${schema.name}: ${schema.description}`),
      '- Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`. Every call resolves to the tool\'s typed canonical JSON value. Tool arguments must be lossless JSON.',
    ].join('\n'),
    ptcTable,
    toolTable: loadTranslations().tools,
    suffix: '',
    onDescribe: untranslated => { reported.push(...untranslated.keys()) },
  })
  assert.match(sdk, /## 给 run_code 写代码/)
  assert.match(sdk, /执行一条 bash 命令/, '工具描述应换成中文译文')
  assert.match(sdk, /- 用 `await tools\.name\(args\)` 调工具/, '固定说明应换成中文')
  assert.match(sdk, /unknown_tool: Unknown tool\./, '没有译文的工具保留原文')
  assert.deepEqual(reported, ['unknown_tool'])
})

/**
 * 构造一套执行器 mock。
 * @param {'ptc' | 'native'} mode 模式解析结果；测试里可以中途改。
 * @returns 双模式执行器的依赖与调用记录。
 */
function executorParts(mode) {
  const calls = []
  const state = { mode }
  const native = {
    describe: definitions => ({ schemas: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
    execute: async (input) => { calls.push({ via: 'native', input }); return { via: 'native' } },
  }
  const ptc = {
    describe: () => ({ schemas: [runCodeSchema], knownNames: ['run_code'] }),
    execute: async (input) => { calls.push({ via: 'ptc', input }); return { via: 'ptc' } },
  }
  const executor = createModeExecutor({
    resolveMode: () => state.mode,
    native,
    getPtc: () => ptc,
    ptcTable,
    toolTable: loadTranslations().tools,
    suffix: '',
    renderSdk: definitions => `SDK(${definitions.map(definition => definition.name).join(',')})`,
    sectionOrder: name => name === 'tools:ptc-only' ? 800 : 5000,
  })
  return { executor, calls, state }
}

test('PTC 模式：只暴露 run_code，两个段落是中文，execute 走 PTC', async () => {
  const { executor, calls } = executorParts('ptc')
  const described = executor.describe([bashDefinition])
  assert.deepEqual(described.knownNames, ['run_code'])
  assert.equal(described.schemas.length, 1)
  assert.equal(described.schemas[0].name, 'run_code')
  assert.match(described.schemas[0].description, /执行一段 TypeScript 程序/)

  const [ptcOnly, sdk] = executor.sections
  assert.equal(ptcOnly.name, 'tools:ptc-only')
  assert.equal(ptcOnly.order, 800)
  assert.equal(sdk.name, 'tools:sdk')
  assert.equal(sdk.order, 5000)
  assert.equal(ptcOnly.text(), ptcTable.ptcOnly)
  assert.equal(sdk.text([bashDefinition]), 'SDK(bash)')

  await executor.execute({ calls: [] })
  assert.deepEqual(calls.map(call => call.via), ['ptc'])
})

test('原生模式：暴露中文工具声明，PTC 段落为空，execute 走原生', async () => {
  const { executor, calls } = executorParts('native')
  const described = executor.describe([bashDefinition])
  assert.equal(described.schemas[0].name, 'bash')
  assert.match(described.schemas[0].description, /执行一条 bash 命令/)

  const [ptcOnly, sdk] = executor.sections
  assert.equal(ptcOnly.text(), '', '原生模式下 PTC 规则段落必须为空，否则模型会读到不适用的规则')
  assert.equal(sdk.text([bashDefinition]), '', '原生模式下不能出现 PTC 的 SDK 段落')

  await executor.execute({ calls: [] })
  assert.deepEqual(calls.map(call => call.via), ['native'])
})

test('同一个执行器实例跟着设置切换模式，不需要重装', async () => {
  const { executor, calls, state } = executorParts('ptc')
  assert.equal(executor.sections[1].text([bashDefinition]), 'SDK(bash)')

  state.mode = 'native'
  assert.equal(executor.sections[1].text([bashDefinition]), '')
  assert.equal(executor.describe([bashDefinition]).schemas[0].name, 'bash')

  state.mode = 'ptc'
  assert.equal(executor.sections[1].text([bashDefinition]), 'SDK(bash)')
  assert.equal(executor.describe([bashDefinition]).schemas[0].name, 'run_code')

  await executor.execute({ calls: [] })
  await executor.execute({ calls: [] })
  assert.deepEqual(calls.map(call => call.via), ['ptc', 'ptc'])
})

/**
 * 造一个带 `meowTeam` 与 `ptcRuntime` 的最小上下文。
 * @param {{ ptc?: boolean, runtime?: boolean }} [options] 设置服务与 runtime 的可用性。
 * @returns 上下文与可变的设置状态。
 */
function modeContext(options = {}) {
  const state = { ptc: options.ptc ?? true }
  const services = {
    meowTeam: { ptcMode: () => state.ptc },
    ...options.runtime === false ? {} : { ptcRuntime: { language: 'typescript' } },
  }
  return { ctx: { get: name => services[name] }, state }
}

test('模式解析默认开启 PTC，并尊重设置页开关与宿主能力', () => {
  const ready = modeContext()
  assert.equal(resolveExecutorMode(ready.ctx, true), 'ptc', '默认开启：配置服务与 runtime 都在时走 PTC')
  const runtimeOnly = { get: name => name === 'ptcRuntime' ? { language: 'typescript' } : undefined }
  assert.equal(resolveExecutorMode(runtimeOnly, true), 'ptc', '配置服务缺失时按默认开启')

  const off = modeContext({ ptc: false })
  assert.equal(resolveExecutorMode(off.ctx, true), 'native', '设置页关掉后必须走原生')

  const noRuntime = modeContext({ runtime: false })
  assert.equal(resolveExecutorMode(noRuntime.ctx, true), 'native', '没有 PTC runtime 时退回原生')

  assert.equal(resolveExecutorMode(ready.ctx, false), 'native', 'PTC 包加载失败时退回原生')

  off.state.ptc = true
  assert.equal(resolveExecutorMode(off.ctx, true), 'ptc', '每次解析都读最新配置，保存后下一轮生效')
})

test('preset 级偏好压过设置页：管家强制原生，也能强制开启', () => {
  const on = modeContext()
  assert.equal(resolveExecutorMode(on.ctx, true, 'native'), 'native', 'preference=native 必须忽略设置页的开启')
  assert.equal(resolveExecutorMode(on.ctx, true, 'ptc'), 'ptc', 'preference=ptc 时按强制开启处理')

  const off = modeContext({ ptc: false })
  assert.equal(resolveExecutorMode(off.ctx, true, 'ptc'), 'ptc', 'preference=ptc 压过设置页的关闭')

  const noRuntime = modeContext({ runtime: false })
  assert.equal(resolveExecutorMode(noRuntime.ctx, true, 'ptc'), 'native', '强制 PTC 也拗不过缺失的 runtime')
})

test('PTC 执行器不可用时执行器仍退回原生', async () => {
  const calls = []
  const executor = createModeExecutor({
    resolveMode: () => 'ptc',
    native: {
      describe: definitions => ({ schemas: definitions.map(({ name, description, parameters }) => ({ name, description, parameters })) }),
      execute: async (input) => { calls.push(input); return { via: 'native' } },
    },
    getPtc: () => undefined,
    ptcTable,
    toolTable: loadTranslations().tools,
    suffix: '',
    renderSdk: () => '',
    sectionOrder: () => 0,
  })
  assert.equal(executor.describe([bashDefinition]).schemas[0].name, 'bash')
  assert.equal(executor.sections[0].text(), '')
  await executor.execute({ calls: [] })
  assert.equal(calls.length, 1, 'PTC 缺失时 execute 必须落到原生执行器')
})
