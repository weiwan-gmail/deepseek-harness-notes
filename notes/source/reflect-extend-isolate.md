# Reflect 深读：extend / isolate / intercept

补充篇，不占主干课表编号。01 已经把这三行当成「长出子厨房」扫过；本篇从 JavaScript / TypeScript 的对象模型讲起，再逐行走 vendor 里的真代码。

课表：[source-curriculum.md](source-curriculum.md) · 相关：[01 Context 与 Fiber](01-cordis-context-fiber.md) · [03 inject / provide](03-reactive-coeffects.md) · [12 agent-scope](12-agent-scope.md)

源码用 GitHub raw / API 拉取，**没有** clone `deepseek-ai/deepseek-harness` 或 `cordiverse/cordis`。

对照版本：

| 来源 | 路径 / 钉住 |
|---|---|
| Harness 钉住 | `master` @ `47f943859bef60e4160492346772ded9b24f765a`（`dsh@0.1.0-rc.5`；已重核 HEAD） |
| 三件套 | `vendor/cordis/src/context.ts`（`extend` / `isolate` / `intercept`） |
| 解析 | `vendor/cordis/src/reflect.ts`（`ReflectService.handler`、`provide`、`_getImpl`） |
| 拦截合并 | `vendor/cordis/src/service.ts`（`Service[symbols.resolveConfig]`） |
| 符号与描边 | `vendor/cordis/src/utils.ts`（`symbols`、`getTraceable`） |
| 文档 | `docs/cordis-api/context.md` |
| 论文 | *A Programming Paradigm for Spatiotemporal Composability*（2026-08-13 草稿）定义 28–29；实现是符号标签，不是另起进程 |

本篇钉子：`extend` 不是 `Object.assign` 拷一份厨房。`isolate` 不是 `Proxy` 换一套 `ctx.tools`。`intercept` 不是改父亲的配置。三件事共用同一套 JS 零件：**原型链叠一层、自有属性盖住继承、`Reflect` 按描述符原样搬键（含 symbol）**。

---

## 先把 JS 零件摆上桌

### 对象有两层：自己的，和原型上的

每个普通对象有一张**自有属性**表，背后还有一条**原型链**。读 `obj.x` 时，引擎先看自己有没有 `x`，没有再沿 `Object.getPrototypeOf(obj)` 往上走，一直走到 `null`。

`Object.create(parent)` 造一个**空的新对象**，把它的原型设成 `parent`。新对象一开始没有任何自有属性；读不到的键会落到 `parent` 上。**`parent` 本身不被改。**

```js
const parent = { a: 1 }
const child = Object.create(parent)
child.b = 2
child.a                 // 1，从原型读到
child.b                 // 2，自有
Object.hasOwn(child, "a") // false
parent.b                // undefined，父亲没被写
```

这就是 Cordis 子上下文的第一句话：子厨房能看见父厨房的插座，往自己墙上钉钉子不会砸到父亲。

`Object.create(null)` 更干净：原型是 `null`，没有 `toString`、没有 `hasOwnProperty`。根上的 isolate / intercept 表就是这样造的，避免和 `Object.prototype` 上的名字撞车。

### 属性不是一个值，是一份描述符

`obj.x = 1` 其实是在装一份**属性描述符**。数据描述符长这样：

```js
{
  value: 1,
  writable: true,
  enumerable: true,
  configurable: true,
}
```

还有访问器描述符（`get` / `set`，没有 `value`）。`Object.assign` 只拷可枚举的字符串键，而且是读值再赋值，**会丢掉** getter、不可枚举、symbol 键。Cordis 要搬的恰恰是 symbol 键上的整张影子表，所以它不用 `assign`。

### `Reflect` 是同一套操作的函数形态

`Reflect` 上的方法和对象内部槽一一对应，返回值也更老实（失败多半是 `false` 或空，而不是乱抛）。本篇用到的四件：

| 调用 | 干什么 | 和 `Object.*` 的差别 |
|---|---|---|
| `Reflect.ownKeys(obj)` | 自有键：字符串 **加** symbol，含不可枚举 | `Object.keys` 只有可枚举字符串；`Object.getOwnPropertySymbols` 只有 symbol |
| `Reflect.getOwnPropertyDescriptor(obj, key)` | 只看**自有**描述符，不沿原型走 | 和 `Object.getOwnPropertyDescriptor` 几乎一样 |
| `Object.defineProperty(obj, key, desc)` | 按描述符原样装键 | 拷的是描述符，不是读出来的值 |
| `Reflect.get` / `set` / `has` | 读、写、问「有没有」，尊重原型和 Proxy | 给 Proxy trap 里当默认转发，避免再进一次 trap 死循环 |

TypeScript 里的 `Reflect.getOwnPropertyDescriptor(...)!` 那个 `!` 只是非空断言：作者认定 `ownKeys` 刚列出来的键，描述符一定在。运行时没有这个符号。

### `Symbol` 是不会撞名的键

`Symbol("isolate")` 每次都是一枚**新的**独一无二的键，就算描述字符串一样。`Symbol.for("cordis.isolate")` 则是运行时全局登记：同一进程里同名拿回同一枚。

Cordis 的地图键用的是后者：

```ts
// vendor/cordis/src/utils.ts
isolate: Symbol.for("cordis.isolate"),
intercept: Symbol.for("cordis.intercept"),
shadow: Symbol.for("cordis.shadow"),
```

所以 `ctx[symbols.isolate]` 不会和插件自己的 `ctx.isolate` 字符串属性打架。`Context.isolate` 是同一枚 symbol 的静态别名。`Context.is` 也用 `Symbol.for("cordis.is")` 打品牌，跨 realm、多份 cordis 副本也能认出来——`instanceof` 做不到这一点。

### Proxy 把「读 ctx.tools」变成一次解析

根上下文构造函数最后 `return new Proxy(this, ReflectService.handler)`。以后你拿到的 `ctx` 是代理。读字符串属性时，handler 的 `get` 决定去哪找服务；读 **symbol** 键时，它当成特殊属性，直接 `Reflect.get(target, prop, ctx)`，不再走服务解析。

所以 `this[symbols.isolate]` 读的是对象上那张影子表，不是某个叫 isolate 的服务。

---

## extend：叠一层，不改父亲

真代码在 `vendor/cordis/src/context.ts`，比 01 引用的那截多两行 shadow：

```ts
extend(meta = {}): this {
  const shadow = Reflect.getOwnPropertyDescriptor(this, symbols.shadow)?.value
  const self = Object.create(getTraceable(this, this))
  for (const prop of Reflect.ownKeys(meta)) {
    Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
  }
  if (!shadow) return self
  return Object.assign(Object.create(self), { [symbols.shadow]: shadow })
}
```

逐行：

1. **先问自己有没有 `cordis.shadow`。** `getOwnPropertyDescriptor(this, symbols.shadow)` 只看自有，不沿原型。没有这枚键就 `undefined`。普通子厨房走不到最后两行。
2. **`Object.create(getTraceable(this, this))`。** `getTraceable` 见 `utils.ts`：值不是对象就原样返回；自有 `shadow` 则剥到原型；有 `tracker` 才包一层描边代理。Context 自己通常没有 tracker，这里约等于 `Object.create(this)`：新对象的原型是当前这份 ctx。
3. **`Reflect.ownKeys(meta)` + `defineProperty`。** 把 `meta` 的每一个自有键（字符串和 symbol、可枚举和不可枚举、getter 也算）按描述符搬到新对象上。这些键变成**自有属性**，读的时候盖住原型上的同名键。父亲身上什么都没被写。
4. **若自己带着 shadow，再垫一层。** `Object.create(self)` 再叠一个空壳，`Object.assign` 只把 shadow 这枚 symbol 拷上去。外层读普通键落到 `self`，再落到原来的 ctx；shadow 则停在最外层。这是描边协议，不是 isolate。

厨房：`extend` 是在同一间厨房里多贴一张工作单。`new Fiber` 时就是 `parent.extend({ fiber: this })`，子插件看到的 `ctx.fiber` 是自己，不是父亲。工作单是自有属性；水电还是原型上那一套。

`isolate` / `intercept` 都先造一张新影子表，再交给 `extend` 当成 `meta` 钉上去。它们没有第二套造子上下文的办法。

---

## isolate：换回路，不换插座名字

```ts
isolate(name: string, label?: symbol) {
  const shadow = Object.create(this[symbols.isolate])
  shadow[name] = label ?? Symbol(name)
  return this.extend({ [symbols.isolate]: shadow })
}
```

`this[symbols.isolate]` 走 Proxy 的 symbol 分支，拿到**当前这间厨房的隔离表**。根构造里是：

```ts
this[symbols.isolate] = Object.create(null)
this[symbols.intercept] = Object.create(null)
```

然后：

1. **`Object.create(父表)`** 造一张新表，原型是父表。没改的服务名沿原型读到父亲的标签。
2. **`shadow[name] = label ?? Symbol(name)`** 只给这一个服务名钉一枚**自有**标签。默认 `Symbol(name)` 每次都是新的（这里不是 `Symbol.for`），所以默认就是一条新回路。传入同一枚 `label`，两间子厨房的这个名字指向同一格。
3. **`this.extend({ [symbols.isolate]: shadow })`** 把新表当成自有属性盖在子 ctx 上。读 `child[symbols.isolate]` 得到新表；读 `parent[symbols.isolate]` 仍是旧表。

名字还叫 `tools`，回路换了。这不是把 `ctx.tools` 做成另一个 Proxy 字段。

### 标签怎样变成仓库格子

`provide` / `_getImpl` 在 `vendor/cordis/src/reflect.ts`。实现不按名字存，按**当前厨房里这个名字的标签**存：

```ts
// provide 节选
this.ctx.root[symbols.isolate][name] ??= Symbol(name)
const key = this.ctx[symbols.isolate][name]
this.store[key] = impl
this.ctx.fiber.store![name] = impl
```

```ts
_getImpl(name: string, strict = true) {
  const key = this.ctx[symbols.isolate][name]
  const impl = key && this.store[key]
  if (!impl) return
  if (strict && impl.fiber.state !== FiberState.ACTIVE) return
  return impl
}
```

根上若这个名字还没有标签，先给根钉一枚默认的 `Symbol(name)`。之后大家都走 `this.ctx[symbols.isolate][name]`：

- 没 isolate 过：子表原型落到根，读到同一枚默认标签，和父亲抢同一格 `store[key]`。
- isolate 过：子表自有一枚新标签，`store[新标签]` 是另一格。父亲的实现还在旧格子里。

`store` 的 TypeScript 写成 `Dict<Impl, symbol>`：键是 symbol，不是服务名字符串。同名服务可以同时活两份，只要标签不同。

Proxy 的 `get` 还会沿纤程父链往上找 `fiber.store[prop]`。每爬一层都核对 `fiber.parent[symbols.isolate][prop] !== key`，标签对不上就停。子回路看不到父回路的同名服务。这是空间可组合在查找路径上的钉子，不是另起一个进程。

两次 `isolate("llm", sameLabel)`：两间子厨房的 `llm` 读到同一枚标签，`provide` 进同一格。这就是文档说的「同一个 isolate realm」。Harness 的 agent preset 用它给一个会话另套能力；`cordis:group` 和 `cordis:include` 要把同一枚标签同时交给提供方和消费者。

---

## intercept：只贴配置条，不换电器

```ts
intercept(name: string, config: any) {
  const intercept = Object.create(this[symbols.intercept])
  intercept[name] = config
  return this.extend({ [symbols.intercept]: intercept })
}
```

和 isolate **同一形状**：`Object.create` 叠表，只给 `name` 钉自有项，再 `extend` 盖到子 ctx。差别是表里存的不是回路标签，是一份配置对象。

谁来读这张表？`Service[symbols.resolveConfig]`，`vendor/cordis/src/service.ts`：

```ts
[symbols.resolveConfig](base?: T, head?: T): T {
  let intercept = this.ctx[Context.intercept]
  const configs: any[] = []
  while (this.name in intercept) {
    if (Object.hasOwn(intercept, this.name)) {
      configs.unshift(intercept[this.name])
    }
    intercept = Object.getPrototypeOf(intercept)
  }
  if (base) configs.unshift(base)
  if (head) configs.push(head)
  if (this["Config"]?.merge) {
    return this["Config"].merge(...configs)
  } else {
    return Object.assign({}, ...configs)
  }
}
```

逐行：

1. 从**当前** `this.ctx` 的 intercept 表开始，不是从根。
2. `this.name in intercept` 会沿原型走：祖先贴过这个服务的条，这里也算「有」。
3. 只有 `Object.hasOwn` 的那一层才 `unshift` 进数组。更靠近根的先被推进去，所以合并顺序是**祖先在前、近的在后**。
4. 可选 `base` 垫最前，`head` 垫最后。有 `Config.merge` 用它，否则 `Object.assign({}, ...configs)` 浅合并。

父亲的 intercept 表没有被写。子树里启动的插件看见多出来的条；走出这间子厨房，条就沿原型消失。

厨房：不换咖啡机，只在这间子厨房的插座上贴一张电压纸条。机器还是那台，启动参数不一样。

TypeScript 重载：

```ts
intercept<K extends string & keyof Context>(
  name: K,
  config: Context[K] extends { [symbols.config]: infer T } ? T : never,
): this
intercept(name: string, config: any): this
```

第一档想把 `config` 收成该服务声明的 `[symbols.config]` 类型。服务类上 `declare [symbols.config]: T` 是幽灵类型，运行时没有这枚字段。对不上的名字落到第二档 `any`。这是类型层的礼貌，不是运行时检查。

---

## 读 ctx.tools 时，这三张表怎么上场

`ReflectService.handler.get` 节选（`vendor/cordis/src/reflect.ts`）：

```ts
if (isSpecialProperty(prop)) {
  return Reflect.get(target, prop, ctx)
}
if (Reflect.has(target, prop)) {
  return getTraceable(ctx, Reflect.get(target, prop, ctx))
}
// ...
const key = target[symbols.isolate][prop]
let fiber = (ctx[symbols.shadow] as Context ?? ctx).fiber
while (true) {
  const impl = fiber.store?.[prop]
  if (impl) return getTraceable(ctx, impl.value)
  if (prop in fiber.inject) { /* 已声明依赖但上下文未激活 */ throw error }
  if (!fiber.runtime) throw error
  if (fiber.parent[symbols.isolate][prop] !== key) throw error
  fiber = fiber.parent.fiber
}
```

三张表的分工：

| 零件 | 上场时机 |
|---|---|
| `extend` 钉的自有属性（如 `fiber`） | `Reflect.has(target, prop)` 为真，直接返回，不走服务仓库 |
| isolate 标签 `key` | 决定沿父链爬到哪一层必须停，以及 `store` 用哪一格 |
| intercept 表 | **不在这条 get 路径上**。它在服务自己 `resolveConfig` 时才被折 |

`isSpecialProperty`：symbol、`prototype` / `then`、纯数字字符串、`_` 开头，一律当普通字段。`then` 是为了不让 Promise 把 ctx 当成 thenable。

---

## 和 12 的 createScope 不是一件事

12 读过：Harness 给每位活着的 agent 一根子纤程，用空 `ctx.plugin` + `dsh.scope`，**不是** `ctx.isolate` / `ctx.intercept`。`packages/core/scope` 里没有 `isolate.ts`。

| | Cordis isolate | Harness createScope |
|---|---|---|
| 改什么 | 某个服务名的回路标签 | 一位厨师的工位（子纤程 + 作用域层） |
| 同名服务 | 可以两份并存（两枚标签） | 刀和提示词跟工位走，下班带走 |
| 父亲 | 旧标签那格还在 | 总灶、名册还在 |

preset 给一个会话换一套同名电器，才是 isolate realm。不要和「这位厨师的工位」混成一句。

---

## 对回论文

定义 28–29 说：同一逻辑依赖，不同部件可以看见不同绑定。实现就是 isolate 表上的 symbol 标签 + `store[label]`。`extend` 是造子上下文的 JS 手段，论文没有 `Object.create`。`intercept` 是配置合并，论文对象里没有。

`ctx.isolate` / `ctx.intercept` 作为方法挂在 Context 上，调用一次是造孩子（acquisition 的结果是新 ctx）；卸插件并不会自动「反 isolate」——被卸的是那根纤程上 `provide` 出去的实现。标签表活在子 ctx 对象上，对象没人拿了就一起走。

---

## 文档对不上的地方

- 课表直觉里的 `packages/core/isolate.ts`、`ctx.reflect.extend`：**没有**。三件套是 `Context` 上的方法，反射层是 `ctx.reflect` 的 get/set/provide。
- 01 引用 `extend` 时省略了 shadow 两行。完整版在本篇。没有 shadow 时行为和 01 写的一样。
- `Symbol(name)`（isolate 默认标签）和 `Symbol.for("cordis.isolate")`（地图键）不是一枚。前者每次新回路，后者全进程同一把地图。
- `Object.assign` 出现在 extend 的 shadow 分支和 `resolveConfig` 的浅合并，**不是** extend 搬 `meta` 的那条路。搬 `meta` 走的是 `ownKeys` + `defineProperty`。
- 12 的 `createScope` 不调用这两张影子表。

---

## 读完可以记住的三句

1. **`extend`** = `Object.create(父 ctx)` + 按描述符钉自有键。父亲只被当成原型。
2. **`isolate`** = 给一个服务名换一枚 symbol 标签，仓库按标签分格。名字没变，回路变了。
3. **`intercept`** = 同一手法叠配置表，`resolveConfig` 从近到远折祖先。不换实现，只改启动参数。
