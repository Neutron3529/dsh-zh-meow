/**
 * 喵体中文的 Host 半侧空入口。
 *
 * `@local/dsh-zh-meow` 的裸包名 Loader 行需要这个入口；浏览器半侧
 * （`client/index.js`）只会挂在裸包名行上，所以这一行同时是设置页的载体。
 * 空 `apply` 不注册任何东西。
 *
 * @module zh-meow/client-entry
 */

/** Cordis 插件名。 */
export const name = 'zh-meow-client-entry'

/** 不做任何事。 */
export function apply() {}
