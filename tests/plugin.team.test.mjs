/**
 * 团队协议、teamRole 配置与报告路径测试。
 *
 * 这些测试不依赖 DSH 运行时：`apply` 的 systemPrompt / tools 服务用最小 mock
 * 驱动，协议文本直接从 `data/team/` 读取。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Config,
  apply,
  loadTeamProtocol,
  renderVerifierList,
  reportPath,
} from '../plugin/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const protocol = name => readFileSync(join(root, 'data', 'team', name), 'utf8')

/**
 * 用最小 mock 驱动 apply。
 * @param {object} config 插件配置。
 * @param {object} [service] `meowTeam` 服务；省略表示服务不可用。
 * @returns 注册的段落与瀑布监听器。
 */
async function runApply(config, service) {
  const sections = []
  const listeners = []
  const ctx = {
    on: (name, handler) => { listeners.push({ name, handler }) },
    logger: { warn() {} },
    systemPrompt: {
      section: (section) => { sections.push(section); return () => {} },
      getSectionOrder: (name) => {
        assert.equal(name, 'TEAM_POLICY')
        return 600
      },
    },
    get: (name) => name === 'meowTeam' ? service : undefined,
  }
  await apply(ctx, config)
  return { sections, listeners }
}

test('四份角色协议存在且包含关键约束', () => {
  const steward = protocol('steward.md')
  assert.match(steward, /读文件的纪律/)
  assert.match(steward, /subagent_coder/)
  assert.match(steward, /subagent_verifier/)
  assert.match(steward, /subagent_probe/)
  assert.match(steward, /meow_cleanup/)
  assert.match(steward, /PASS/)
  assert.match(steward, /未启用独立校验者/)
  // 管家可以读，但不许跑命令、不许改项目文件。
  assert.match(steward, /没有 `bash`、`pwsh`/)
  assert.match(steward, /只写 `\.meow-team\/` 下的任务文件/)

  const coder = protocol('coder.md')
  assert.match(coder, /自检/)
  assert.match(coder, /send_message/)
  assert.match(coder, /需要主人澄清/)

  const probe = protocol('probe.md')
  assert.match(probe, /可行性探针/)
  assert.match(probe, /不实现/)
  assert.match(probe, /git status --porcelain/)
  assert.match(probe, /不可行/)
  assert.match(probe, /不再开子 agent/)

  const verifier = protocol('verifier.md')
  assert.match(verifier, /PASS/)
  assert.match(verifier, /FAILED/)
  assert.match(verifier, /AMBIGUOUS/)
  assert.match(verifier, /两轮/)
})

test('loadTeamProtocol 读取角色文件，未知角色返回空串', () => {
  assert.match(loadTeamProtocol('steward'), /管家协议/)
  assert.match(loadTeamProtocol('probe'), /可行性探针协议/)
  assert.equal(loadTeamProtocol('bogus'), '')
  assert.equal(loadTeamProtocol(''), '')
})

test('teamRole 只接受空串或四个角色', () => {
  const validate = Config['~standard'].validate
  assert.equal(validate({}).value.teamRole, '')
  assert.equal(validate({ teamRole: 'steward' }).value.teamRole, 'steward')
  assert.equal(validate({ teamRole: 'probe' }).value.teamRole, 'probe')
  assert.ok(validate({ teamRole: 'bogus' }).issues)
  assert.ok(validate({ teamRole: 42 }).issues)
})

test('renderVerifierList 描述槽位、继承与空清单', () => {
  const rows = renderVerifierList([
    { id: 'v1', model: '', effort: 'high', mode: 'two-round' },
    { id: 'v2', model: 'deepseek-official/deepseek-flash', effort: 'max', mode: 'one-shot' },
  ], true)
  assert.match(rows, /v1/)
  assert.match(rows, /继承父 agent/)
  assert.match(rows, /两轮/)
  assert.match(rows, /一次拿全/)
  assert.match(rows, /deepseek-official\/deepseek-flash/)

  assert.match(renderVerifierList([], true), /没有启用的校验者/)
  assert.match(renderVerifierList([], false), /内置默认/)
})

test('apply 在 teamRole 非空时注册 meow:team 段落，并带启用清单', async () => {
  const service = {
    coder: () => ({ model: '', effort: 'low' }),
    verifiers: () => [{ id: 'v9', model: '', effort: 'high', mode: 'two-round' }],
  }
  const { sections } = await runApply({ teamRole: 'steward' }, service)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'meow:team')
  assert.equal(sections[0].order, 600)
  const text = sections[0].text()
  assert.match(text, /管家协议/)
  assert.match(text, /v9/)
  assert.match(text, /high/)
})

test('apply 在 0 个启用校验者时提示直接采用码农交付', async () => {
  const service = { coder: () => ({ model: '', effort: 'low' }), verifiers: () => [] }
  const { sections } = await runApply({ teamRole: 'steward' }, service)
  assert.match(sections[0].text(), /没有启用的校验者/)
})

test('apply 在配置服务不可用时仍注册协议并使用内置默认', async () => {
  const { sections } = await runApply({ teamRole: 'steward' })
  const text = sections[0].text()
  assert.match(text, /管家协议/)
  assert.match(text, /设置服务不可用/)
  assert.match(text, /v2/)
})

test('校验者清单只出现在管家的段落里', async () => {
  const service = {
    coder: () => ({ model: '', effort: 'low' }),
    verifiers: () => [{ id: 'v9', model: '', effort: 'high', mode: 'two-round' }],
  }
  for (const teamRole of ['coder', 'verifier', 'probe']) {
    const { sections } = await runApply({ teamRole }, service)
    const text = sections[0].text()
    assert.ok(!text.includes('调用一次 `subagent_verifier`'), `${teamRole} 不该拿到校验者清单`)
    assert.ok(!text.includes('本次启用的校验者'), `${teamRole} 不该拿到校验者清单`)
  }
})

test('teamRole 为空时不注册 meow:team 段落', async () => {
  const { sections } = await runApply({})
  assert.equal(sections.length, 0)
})

test('漏翻报告按角色分文件', () => {
  assert.match(reportPath(''), /\.untranslated-report\.json$/)
  assert.match(reportPath('steward'), /\.untranslated-report\.steward\.json$/)
  assert.match(reportPath('coder'), /\.untranslated-report\.coder\.json$/)
  assert.match(reportPath('probe'), /\.untranslated-report\.probe\.json$/)
})
