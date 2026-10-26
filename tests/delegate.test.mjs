/**
 * 模型/强度 → agentOptions 的纯函数测试。
 *
 * 关键约定：空字符串 = 继承，不传对应字段；`model` 非空时必须是
 * `provider/model`。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { toAgentOptions } from '../plugin/route.js'

test('两个字段都留空：完全继承，返回 undefined', () => {
  assert.equal(toAgentOptions({ model: '', effort: '' }), undefined)
  assert.equal(toAgentOptions({}), undefined)
  assert.equal(toAgentOptions(undefined), undefined)
})

test('只给强度：只传 reasoningEffort', () => {
  assert.deepEqual(toAgentOptions({ model: '', effort: 'low' }), { reasoningEffort: 'low' })
})

test('只给模型：拆成 provider 与 model', () => {
  assert.deepEqual(
    toAgentOptions({ model: 'deepseek-official/deepseek-flash', effort: '' }),
    { provider: 'deepseek-official', model: 'deepseek-flash' },
  )
  assert.deepEqual(
    toAgentOptions({ model: 'vendor/model-with/slash', effort: '' }),
    { provider: 'vendor', model: 'model-with/slash' },
  )
})

test('两个字段都给：三者一起传', () => {
  assert.deepEqual(
    toAgentOptions({ model: 'deepseek-official/deepseek-flash', effort: 'max' }),
    { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  )
})

test('空白字符串按空处理', () => {
  assert.equal(toAgentOptions({ model: '   ', effort: '  ' }), undefined)
  assert.deepEqual(toAgentOptions({ model: ' p/m ', effort: ' high ' }), {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  })
})

test('模型没有 provider/model 结构时报可读错误', () => {
  assert.throws(() => toAgentOptions({ model: 'bogus', effort: '' }), /provider\/model/)
  assert.throws(() => toAgentOptions({ model: '/model', effort: '' }), /provider\/model/)
  assert.throws(() => toAgentOptions({ model: 'provider/', effort: '' }), /provider\/model/)
})
