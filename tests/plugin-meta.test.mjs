/**
 * 插件显示文案（locale）的静态断言。
 *
 * 设置 → 内置插件 里，Loader 行的标题 / 描述来自 `<specifier>/locale/*.json`
 * 的 `meta` 字段（见 DSH 的 readPluginMeta）：子路径 specifier 不读
 * package.json，所以 `@local/dsh-zh-meow/plugin` 的文案只能靠这些词典，
 * 缺了就会退化成短名 `zh-meow/plugin` 且没有描述。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** 读一个 locale 词典。 @param {string} language 语言 id。 */
function dictionary(language) {
  return JSON.parse(readFileSync(join(root, 'plugin', 'locale', `${language}.json`), 'utf8'))
}

test('英文入口与中文词典都带标题和描述', () => {
  for (const language of ['en', 'zh']) {
    const meta = dictionary(language).meta
    assert.equal(typeof meta.title, 'string', `${language}.json 缺 meta.title`)
    assert.ok(meta.title.trim().length > 0, `${language}.json 的 meta.title 不能为空`)
    assert.equal(typeof meta.description, 'string', `${language}.json 缺 meta.description`)
    assert.ok(meta.description.trim().length > 0, `${language}.json 的 meta.description 不能为空`)
  }
})

test('中文词典的标题与描述是喵体中文', () => {
  const meta = dictionary('zh').meta
  assert.match(meta.title, /喵体中文/)
  assert.match(meta.description, /模型/)
  assert.match(meta.description, /中文/)
})

test('package 清单把 locale 资源暴露给插件清单', () => {
  // readPluginMeta 用 `<specifier>/locale/<language>.json` 解析，specifier 是
  // `@local/dsh-zh-meow/plugin`，所以 exports 必须覆盖 `./plugin/locale/*`。
  const target = pkg.exports['./plugin/locale/*']
  assert.equal(target, './plugin/locale/*')
  for (const language of ['en', 'zh']) {
    const relative = target.replace('*', `${language}.json`)
    assert.doesNotThrow(() => readFileSync(join(root, relative), 'utf8'), `${relative} 必须存在`)
  }
})
