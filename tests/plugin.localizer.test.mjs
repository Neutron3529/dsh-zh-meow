/**
 * zh-meow 本地化插件的回归测试。
 *
 * 核心回归点有两个：
 *   1. 动态段落：当上游用空字符串表示「该段落当前不适用」时，插件必须原样保留
 *      空串，好让 `renderPrompt` 继续把它过滤掉。无条件替换会让这类段落在本不
 *      适用时出现在提示词里，模型因此误判自身状态。
 *   2. 装配瀑布不再携带工具声明（DSH 0.2.1-rc.2 起）：处理器绝不能读取
 *      `assembly.tools`，否则每个模型请求都会抛 TypeError。工具译文改由作用域
 *      执行器的 `describe()` 提供。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, createTranslatingExecutor, loadTranslations } from '../plugin/index.js'

/** 本次装配里的一个段落。 */
const section = (name, text) => ({ name, text })

/** 工具定义（describe 只读 name/description/parameters）。 */
const definition = (name, description, parameters = { type: 'object', properties: {} }) =>
  ({ name, description, parameters })

/** 真实译文数据里的工具表。 */
const toolTable = loadTranslations().tools

/**
 * 用假装配驱动插件的 `system-prompt/assemble` 处理器。
 * @param {{ sections?: object[], contexts?: object[], variables?: object }} presentation 待处理的装配（不含工具）。
 * @param {object} [config] 插件配置。
 * @returns 处理器返回的装配。
 */
async function assemble(presentation, config = {}) {
  const listeners = []
  await apply({ on: (name, handler) => { listeners.push({ name, handler }) }, logger: { warn() {} } }, config)
  const found = listeners.find(listener => listener.name === 'system-prompt/assemble')
  assert.ok(found, '插件必须注册 system-prompt/assemble 处理器')
  const full = {
    sections: presentation.sections ?? [],
    contexts: presentation.contexts ?? [],
    variables: presentation.variables ?? {},
  }
  return found.handler({ sections: [], contexts: [], variables: {} }, {}, async () => full)
}

/**
 * 用真实译文表描述一组工具定义。
 * @param {object[]} definitions 工具定义。
 * @returns {object[]} 模型可见的工具 schema。
 */
function describe(definitions) {
  const executor = createTranslatingExecutor({ execute: async () => { throw new Error('execute 不应被调用') } }, toolTable)
  return executor.describe(definitions).schemas
}

test('装配瀑布不读取工具声明，只返回段落/上下文/变量', async () => {
  const out = await assemble({ sections: [section('harness:identity', 'EN identity')] })
  assert.equal(out.tools, undefined, '处理器不得向装配结果里塞 tools 字段')
  assert.equal(out.sections[0].text, '人家是一只由 DeepSeek Harness 驱动的 AI 猫娘喵。')
  assert.deepEqual(out.contexts, [])
  assert.deepEqual(out.variables, {})
})

test('原文为空的动态段落保持为空，译文不生效', async () => {
  const out = await assemble({ sections: [section('plan:policy', '')] })
  assert.equal(out.sections[0].name, 'plan:policy')
  assert.equal(out.sections[0].text, '', '空原文必须原样保留，否则该段落会绕过 renderPrompt 的空文本过滤')
})

/**
 * 数据文件里标了 `dynamic` 的全部段落。
 *
 * 这些段落的上游注册都用「返回空串」表示当前不适用，漏标一个就会让模型
 * 在该段落不适用时读到它（历史缺陷：非计划模式下读到整段计划模式规则）。
 */
const DYNAMIC_SECTIONS = [
  'plan:policy',
  'tool:read',
  'tool:write',
  'tool:edit',
  'tool:glob',
  'tool:grep',
]

test('每一个标记为 dynamic 的段落都在空原文时保持为空', async () => {
  for (const name of DYNAMIC_SECTIONS) {
    const out = await assemble({ sections: [section(name, '')] })
    assert.equal(out.sections[0].text, '', `${name} 在原文为空时必须保持为空`)
  }
})

test('每一个标记为 dynamic 的段落都在原文非空时换成译文', async () => {
  for (const name of DYNAMIC_SECTIONS) {
    const out = await assemble({ sections: [section(name, '原文正文')] })
    assert.notEqual(out.sections[0].text, '原文正文', `${name} 应换成中文译文`)
    assert.equal(out.sections[0].text.length > 0, true, `${name} 的译文不应为空`)
  }
})

test('工具段落随未注册的工具一起消失，不会剩下孤儿指导', async () => {
  // 工具未注册时上游给出空文本；译文不得把它变回一段「要用 read 工具…」。
  const out = await assemble({
    sections: [
      section('tool:read', ''),
      section('tool:glob', ''),
      section('tool:grep', ''),
      section('tool:bash', 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'),
    ],
  })
  assert.equal(out.sections[0].text, '')
  assert.equal(out.sections[1].text, '')
  assert.equal(out.sections[2].text, '')
  assert.equal(out.sections[3].text.length > 0, true)
})

test('原文非空的动态段落换成中文译文', async () => {
  const out = await assemble({ sections: [section('plan:policy', '原文正文')] })
  assert.notEqual(out.sections[0].text, '原文正文')
  assert.equal(out.sections[0].text.length > 0, true)
})

test('普通字符串段落无条件替换', async () => {
  const out = await assemble({ sections: [section('harness:identity', 'You are an AI agent powered by DeepSeek Harness.')] })
  assert.equal(out.sections[0].text, '人家是一只由 DeepSeek Harness 驱动的 AI 猫娘喵。')
})

test('没有译文的段落原样返回', async () => {
  const original = section('unknown:section', 'keep me')
  const out = await assemble({ sections: [original] })
  assert.equal(out.sections[0], original, '未命中译文时不应新建对象')
})

test('一次装配里只有动态段落受条件约束', async () => {
  const out = await assemble({
    sections: [
      section('plan:policy', ''),
      section('harness:identity', 'You are an AI agent powered by DeepSeek Harness.'),
      section('unknown:section', 'keep me'),
    ],
  })
  assert.equal(out.sections[0].text, '')
  assert.equal(out.sections[1].text, '人家是一只由 DeepSeek Harness 驱动的 AI 猫娘喵。')
  assert.equal(out.sections[2].text, 'keep me')
})

test('translateSections 关闭且未配置 persona 时段落整段不变', async () => {
  const sections = [section('plan:policy', ''), section('harness:identity', 'You are an AI agent powered by DeepSeek Harness.')]
  const out = await assemble({ sections }, { translateSections: false })
  assert.equal(out.sections[0], sections[0])
  assert.equal(out.sections[1], sections[1])
})

test('translateSections 关闭时只换 persona，其他段落不翻译', async () => {
  const out = await assemble({
    sections: [
      section('deployment:persona-prefix', 'You are a coding agent.'),
      section('harness:identity', 'You are an AI agent powered by DeepSeek Harness.'),
    ],
  }, { translateSections: false, persona: '人家是猫娘喵。' })
  assert.equal(out.sections[0].text, '人家是猫娘喵。')
  assert.equal(out.sections[1].text, 'You are an AI agent powered by DeepSeek Harness.')
})

test('执行器把 describe 的 schema 换中文，execute 原样委托', async () => {
  const calls = []
  const native = { execute: async (input) => { calls.push(input); return { results: [], additionalContexts: [], concluded: false } } }
  const executor = createTranslatingExecutor(native, toolTable)
  const schemas = executor.describe([definition('read', 'Read a UTF-8 text file.')]).schemas
  assert.equal(schemas[0].name, 'read')
  assert.notEqual(schemas[0].description, 'Read a UTF-8 text file.')
  const input = { calls: [] }
  assert.deepEqual(await executor.execute(input), { results: [], additionalContexts: [], concluded: false })
  assert.deepEqual(calls, [input], 'execute 必须原样交给原生执行器')
})

test('执行器保留 deferLoading，且不改动没有译文的工具', async () => {
  const schemas = describe([{ ...definition('unknown_tool', 'Keep me.'), deferLoading: true }])
  assert.equal(schemas[0].description, 'Keep me.')
  assert.equal(schemas[0].deferLoading, true)
})

/**
 * 参数层的回归：参数名 → 译文的映射表在工具条目的 `parameters` 下。
 *
 * 历史缺陷是把工具条目本身当成参数名表传给 `translateNode`，于是每个参数的
 * 描述都命中不到译文——工具级描述是中文，参数描述却整片保留英文。译文条目与
 * 源码 JSON Schema 同构：对象参数用 `properties`，数组参数用
 * `items.properties`。
 */
test('对象参数与数组参数的描述都按 parameters 表替换', async () => {
  const parameters = {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'The plain JavaScript body.' },
      meta: {
        type: 'object',
        description: 'The workflow identity as plain JSON, not code.',
        properties: {
          name: { type: 'string', description: 'Short kebab-case workflow name.' },
          phases: {
            type: 'array',
            description: 'Optional phase declarations matched by phase() calls.',
            items: {
              type: 'object',
              properties: { title: { type: 'string', description: 'The phase title.' } },
            },
          },
        },
      },
    },
  }
  const schemas = describe([definition('workflow', 'Run a workflow script.', parameters)])
  const properties = schemas[0].parameters.properties
  assert.notEqual(properties.script.description, 'The plain JavaScript body.', '顶层参数的描述应换成译文')
  assert.notEqual(properties.meta.description, 'The workflow identity as plain JSON, not code.', '对象参数自身的描述应换成译文')
  assert.notEqual(
    properties.meta.properties.name.description,
    'Short kebab-case workflow name.',
    '对象参数的子属性应换成译文',
  )
  assert.notEqual(
    properties.meta.properties.phases.description,
    'Optional phase declarations matched by phase() calls.',
    '数组参数自身的描述应换成译文',
  )
  assert.notEqual(
    properties.meta.properties.phases.items.properties.title.description,
    'The phase title.',
    '数组元素的属性应换成译文',
  )
})

test('没有译文的参数保持原文，结构字段一律不动', async () => {
  const parameters = {
    type: 'object',
    properties: { unknown_param: { type: 'number', required: true, description: 'Keep me.' } },
  }
  const schemas = describe([definition('workflow', 'EN', parameters)])
  const node = schemas[0].parameters.properties.unknown_param
  assert.equal(node.description, 'Keep me.')
  assert.equal(node.type, 'number')
  assert.equal(node.required, true)
})

test('工具译文条目里的 enumValues 不会被写进 schema', async () => {
  const parameters = {
    type: 'object',
    properties: { scope: { type: 'string', enum: ['children', 'descendants'], description: 'EN scope' } },
  }
  const schemas = describe([definition('list_agents', 'EN', parameters)])
  const node = schemas[0].parameters.properties.scope
  assert.deepEqual(node.enum, ['children', 'descendants'], '枚举取值必须原样保留')
  assert.notEqual(node.description, 'EN scope')
})
