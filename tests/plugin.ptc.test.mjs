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
  Config,
  createModeExecutor,
  loadPtcTable,
  loadTranslations,
  renderLocalizedSdk,
  resolveExecutorMode,
  resolveMergeReadWrite,
  translatePtcSchema,
} from '../plugin/index.js'

/** 真实的 PTC 替换表。 */
const ptcTable = loadPtcTable()

/** 三个 PTC 段落的顺序：上游 `systemPrompt` 拥有这几个常量，测试里照抄一份。 */
const ORDER = { 'tools:ptc-only': 800, 'tools:ptc-merge-rw': 850, 'tools:sdk': 5000 }

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

test('ptc.json 带合并读写指引，正文点出 stale read 原文与同程序重试写法', () => {
  assert.match(ptcTable.mergeReadWrite, /file changed since it was read/, '必须原样点出报错文字，模型才对得上')
  assert.match(ptcTable.mergeReadWrite, /tools\.read/)
  assert.match(ptcTable.mergeReadWrite, /tools\.write/)
  assert.match(ptcTable.mergeReadWrite, /try\/catch|catch/, '要给出在同一个程序里补救的写法')
  assert.match(ptcTable.mergeReadWrite, /不要另起一轮|别把[\s\S]*拆成两次程序调用/)
  assert.doesNotMatch(ptcTable.mergeReadWrite, /并行/, '并行读写绕不过 stale read 检查，不能这么写')
  assert.doesNotMatch(ptcTable.mergeReadWrite, /绕过/, '这个指引不承诺绕过任何检查')
  assert.match(ptcTable.mergeReadWriteHint, /file changed since it was read/)
  assert.match(ptcTable.mergeReadWriteHint, /run_code/)
})

test('合并读写：PTC 模式且开关开启时给出指引，关掉或原生模式时为空', () => {
  const on = executorParts('ptc', { merge: true })
  const [ptcOnly, mergeOn, sdkOn] = on.executor.sections
  assert.equal(mergeOn.text(), ptcTable.mergeReadWrite)
  assert.equal(ptcOnly.text(), ptcTable.ptcOnly, '开关不影响「只能调 run_code」那段')
  assert.equal(sdkOn.text([bashDefinition]), 'SDK(bash)')

  const off = executorParts('ptc', { merge: false })
  assert.equal(off.executor.sections[1].text(), '', '关掉时不能留下半句话')

  const native = executorParts('native', { merge: true })
  assert.equal(native.executor.sections[1].text(), '', '原生模式没有合并读写这回事')
})

test('合并读写开关跟着设置切换，不需要重装执行器', () => {
  const { executor, state } = executorParts('ptc', { merge: false })
  assert.equal(executor.sections[1].text(), '')
  state.merge = true
  assert.equal(executor.sections[1].text(), ptcTable.mergeReadWrite, '打开后下一轮组装就出现')
  state.merge = false
  assert.equal(executor.sections[1].text(), '')
})

test('合并读写开启时给 write / edit 的 SDK 描述追加提示，其它工具不动', () => {
  const hint = ptcTable.mergeReadWriteHint
  const options = {
    // 用 '; ' 分隔工具：追加的提示自带换行，按行切会把工具行切断。
    render: schemas => schemas.map(schema => schema.name + ':' + schema.description).join('; '),
    ptcTable,
    toolTable: loadTranslations().tools,
    suffix: '',
    describeHints: name => (name === 'write' || name === 'edit') ? hint : undefined,
  }
  const sdk = renderLocalizedSdk([
    { name: 'write', description: 'Write a UTF-8 text file.', parameters: { type: 'object', properties: {} } },
    { name: 'edit', description: 'Edit an existing UTF-8 text file.', parameters: { type: 'object', properties: {} } },
    bashDefinition,
  ], options)
  const entries = sdk.split('; ')
  assert.ok(entries.find(entry => entry.startsWith('write:')).includes(hint), 'write 描述应带上提示')
  assert.ok(entries.find(entry => entry.startsWith('edit:')).includes(hint), 'edit 同理会撞上 stale read')
  assert.ok(!entries.find(entry => entry.startsWith('bash:')).includes(hint), '别的工具不该被追加')

  const blank = renderLocalizedSdk([{ name: 'no_desc', description: '' }], { ...options, describeHints: () => hint })
  assert.equal(blank, 'no_desc:', '原文描述为空时不追加，避免凭空造出一条描述')
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
 * @param {{ merge?: boolean }} [options] 「合并读写」开关状态；默认关闭，
 *   免得无关断言被多出来的段落打乱。
 * @returns 双模式执行器的依赖与调用记录。
 */
function executorParts(mode, options = {}) {
  const calls = []
  const state = { mode, merge: options.merge ?? false }
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
    sectionOrder: name => ORDER[name] ?? 5000,
    resolveMergeReadWrite: () => state.merge,
  })
  return { executor, calls, state }
}

test('PTC 模式：只暴露 run_code，三个段落顺序固定，execute 走 PTC', async () => {
  const { executor, calls } = executorParts('ptc')
  const described = executor.describe([bashDefinition])
  assert.deepEqual(described.knownNames, ['run_code'])
  assert.equal(described.schemas.length, 1)
  assert.equal(described.schemas[0].name, 'run_code')
  assert.match(described.schemas[0].description, /执行一段 TypeScript 程序/)

  const [ptcOnly, mergeSection, sdk] = executor.sections
  assert.equal(ptcOnly.name, 'tools:ptc-only')
  assert.equal(ptcOnly.order, 800)
  assert.equal(mergeSection.name, 'tools:ptc-merge-rw')
  assert.equal(mergeSection.order, 850, '合并读写段落紧跟 PTC 规则，排在 SDK 声明之前')
  assert.equal(mergeSection.text(), '', '这个 mock 没开合并读写，段落必须是空串')
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

  const [ptcOnly, mergeSection, sdk] = executor.sections
  assert.equal(ptcOnly.text(), '', '原生模式下 PTC 规则段落必须为空，否则模型会读到不适用的规则')
  assert.equal(mergeSection.text(), '', '原生模式下不能出现合并读写指引：那里本来也合并不了')
  assert.equal(sdk.text([bashDefinition]), '', '原生模式下不能出现 PTC 的 SDK 段落')

  await executor.execute({ calls: [] })
  assert.deepEqual(calls.map(call => call.via), ['native'])
})

test('同一个执行器实例跟着设置切换模式，不需要重装', async () => {
  const { executor, calls, state } = executorParts('ptc')
  assert.equal(executor.sections[2].text([bashDefinition]), 'SDK(bash)')

  state.mode = 'native'
  assert.equal(executor.sections[2].text([bashDefinition]), '')
  assert.equal(executor.describe([bashDefinition]).schemas[0].name, 'bash')

  state.mode = 'ptc'
  assert.equal(executor.sections[2].text([bashDefinition]), 'SDK(bash)')
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
test('合并读写默认开启，尊重设置页开关与 preset 偏好', () => {
  const state = { merge: true }
  const ctx = { get: name => name === 'meowTeam' ? { mergeReadWriteMode: () => state.merge } : undefined }
  assert.equal(resolveMergeReadWrite(ctx), true, '默认跟随设置页（开启）')
  assert.equal(resolveMergeReadWrite({ get: () => undefined }), true, '配置服务缺失时按默认开启')

  state.merge = false
  assert.equal(resolveMergeReadWrite(ctx), false, '设置页关掉后不再出现')
  assert.equal(resolveMergeReadWrite(ctx, 'on'), true, 'preset 级 on 压过设置页的关闭')

  state.merge = true
  assert.equal(resolveMergeReadWrite(ctx, 'off'), false, 'preset 级 off 压过设置页的开启')

  const broken = { get: () => ({ mergeReadWriteMode: () => { throw new Error('boom') } }) }
  assert.equal(resolveMergeReadWrite(broken), true, '读配置抛错时按默认开启，不让指引悄悄消失')
})
test('Config 接受 mergeReadWrite 的三种取值，非法值被拒，缺省是 inherit', () => {
  const validate = Config['~standard'].validate
  for (const value of ['inherit', 'on', 'off']) {
    const result = validate({ mergeReadWrite: value })
    assert.equal(result.issues, undefined, `mergeReadWrite: ${value} 应被接受`)
    assert.equal(result.value.mergeReadWrite, value)
  }
  assert.ok(validate({ mergeReadWrite: 'yes' }).issues, '拼错的值必须报错，而不是静默退回默认')
  assert.equal(validate({}).value.mergeReadWrite, 'inherit', '不写时跟随设置页')
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
