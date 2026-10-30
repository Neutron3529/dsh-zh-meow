/**
 * 客户端 bundle 与 package 清单的静态断言。
 *
 * 手写 lazy-CJS bundle 没法在 node:test 里真正执行（需要浏览器与 React 基座），
 * 这里只锁定格式与约定，防止误改成 ESM 或误引入第三方全家桶。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(root, 'client', 'index.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('客户端 bundle 是 lazy-CJS factory', () => {
  assert.match(client, /window\.__ModuleLoader__\.load/)
  assert.match(client, /id: '@local\/dsh-zh-meow'/)
  assert.match(client, /factory: \(require\)/)
  assert.match(client, /require\('react'\)/)
  assert.ok(!client.includes('export function apply'))
})

test('设置页注册 settings.section 并绑定配置命名空间', () => {
  assert.match(client, /settings\.section/)
  assert.match(client, /const ENTRY_ID = 'meow-team-config'/)
  assert.match(client, /configForms\.get\(ENTRY_ID\)/)
  assert.match(client, /ctx\.locale\.register/)
  assert.match(client, /ctx\.slots\.inject/)
})

test('package.json 声明 web 客户端与全部入口', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client/index.js')
  assert.equal(pkg.exports['./team-config'], './plugin/team-config.js')
  assert.equal(pkg.exports['./delegate'], './plugin/delegate.js')
  assert.equal(pkg.exports['./plugin'], './plugin/index.js')
})

test('不依赖第三方全家桶，也不把 inherit 当成配置值', () => {
  assert.ok(!client.includes('@linxin666'))
  assert.ok(!client.includes("model: 'inherit'"))
  assert.ok(!client.includes("effort: 'inherit'"))
  const delegate = readFileSync(join(root, 'plugin', 'delegate.js'), 'utf8')
  const config = readFileSync(join(root, 'plugin', 'team-config.js'), 'utf8')
  assert.ok(!delegate.includes("'inherit'"))
  assert.ok(!config.includes("'inherit'"))
})

test('Host 入口是空插件，供裸包名 Loader 行使用', () => {
  const entry = readFileSync(join(root, 'index.js'), 'utf8')
  assert.match(entry, /export const name = 'zh-meow-client-entry'/)
  assert.match(entry, /export function apply\(\) \{\}/)
})

test('设置页暴露 PTC 模式开关，配置服务默认开启', () => {
  // 设置页：一个 checkbox，保存到 `ptc` 字段，并带上中英说明。
  assert.match(client, /PTC 模式/)
  assert.match(client, /save\('ptc', event\.target\.checked\)/)
  assert.match(client, /const ptc = snapshot\.value\.ptc !== false/)
  assert.match(client, /PTC mode/)

  const config = readFileSync(join(root, 'plugin', 'team-config.js'), 'utf8')
  assert.match(config, /ptc: z\.boolean\(\)\.default\(true\)\.volatile\(\)/, '默认开启且必须是 volatile 字段')
  assert.match(config, /ptcMode\(\)/)
})
