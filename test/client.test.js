/**
 * Client 半侧单测：假 window + 假 React，只验逻辑与注册，不真渲染。
 *
 * 载体是一个 classic script（`window.__ModuleLoader__.load`），所以用 vm
 * 起一个假窗口跑它，再拿 factory 返回的 `__internals` 做断言。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

let passed = 0
/** @param {string} name - 用例名。 @param {() => void} fn - 用例。 */
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

/** 异步用例：await 保证断言跑完再统计。 */
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

/** 极简 React 替身：只够组件在「不渲染」的前提下被定义与调用。 */
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useRef(value) {
    return { current: value }
  },
}

/** 假的样式表宿主。 */
function makeDocument() {
  const head = { children: [], appendChild(node) { this.children.push(node) } }
  return {
    head,
    body: { appendChild() {}, dataset: {} },
    documentElement: { style: { setProperty() {} }, classList: { contains: () => false } },
    createElement(tag) {
      return { tag, setAttribute() {}, remove() {}, click() {}, style: {}, textContent: '' }
    },
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return true },
    readyState: 'complete',
  }
}

/** 把 vm 另一侧造出来的对象搬回本 realm（否则原型不同，deepStrictEqual 会嫌）。 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

let captured = null
const fakeWindow = { __ModuleLoader__: { load(definition) { captured = definition } } }
const context = vm.createContext({
  window: fakeWindow,
  console,
  document: makeDocument(),
  navigator: {},
  fetch: async () => ({ json: async () => ({ ok: false, code: 'offline' }) }),
  URLSearchParams,
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
  Blob: class Blob { constructor(parts, options) { this.parts = parts; this.type = options?.type ?? '' } },
  setTimeout,
  clearTimeout,
  getComputedStyle: () => ({ getPropertyValue: () => '', colorScheme: 'light', fontFamily: 'system-ui' }),
  MutationObserver: class MutationObserver { observe() {} disconnect() {} },
})
const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')
vm.runInContext(source, context, { filename: 'client.js' })

test('bundle 自报 id', () => {
  assert.equal(captured.id, 'dsh-table-studio')
})

const module = captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`意外的 require：${name}`)
})
const internals = module.__internals

console.log('client.test.js')

test('声明 inject 槽服务', () => {
  assert.deepEqual(plain(module.inject), ['slots', 'sidebarRightTabs', 'sidebarRight'])
})

test('cardData：结构化回执优先', () => {
  const block = {
    kind: 'tool-call',
    call: { args: { title: '穴位' } },
    content: [{ type: 'text', text: '「穴位」· 2 列 × 1 行 · id tbl_20261118_abcdef' }],
    result: { value: { ok: true, id: 'tbl_20261118_abcdef', title: '穴位', data: { columns: ['a', 'b'], rows: [['1', '2']] } } },
  }
  const info = internals.cardData(block)
  assert.equal(info.id, 'tbl_20261118_abcdef')
  assert.equal(info.title, '穴位')
  assert.deepEqual(plain(info.data.columns), ['a', 'b'])
})

test('cardData：只有文本时从 id 反推', () => {
  const block = {
    kind: 'tool-call',
    call: { args: {} },
    content: [{ type: 'text', text: '表格 · 3 列 × 2 行 · id tbl_20261118_123abc' }],
  }
  const info = internals.cardData(block)
  assert.equal(info.id, 'tbl_20261118_123abc')
  assert.equal(info.data, null, '没有数据时交给 fetch 兜底')
})

test('cardData：从参数里现场拼表', () => {
  const block = { kind: 'tool-call', call: { args: { title: '参数表', columns: ['x', 'y'], rows: [[1, 2]] } }, content: [] }
  const info = internals.cardData(block)
  assert.equal(info.title, '参数表')
  assert.deepEqual(plain(info.data.columns), ['x', 'y'])
  assert.deepEqual(plain(info.data.rows), [['1', '2']])
})

test('cardData：csv 参数也能拼表', () => {
  const block = { kind: 'tool-call', call: { args: { csv: '甲,乙\n1,2\n' } }, content: [] }
  const info = internals.cardData(block)
  assert.deepEqual(plain(info.data.columns), ['甲', '乙'])
  assert.deepEqual(plain(info.data.rows), [['1', '2']])
})

test('cardData：没有 block 时算「生成中」', () => {
  const info = internals.cardData(undefined)
  assert.equal(info.running, true)
  assert.equal(info.data, null)
})

test('argsRaw 半截 JSON 不抛错', () => {
  const block = { phase: 'start', argsRaw: '{"title":"半' }
  const info = internals.cardData(block)
  assert.equal(info.running, true)
})

test('CSV 文本带 BOM + 转义', () => {
  const text = internals.toCsvText({ columns: ['位置', '备注'], rows: [['合谷', '带,逗号']] })
  assert.equal(text.codePointAt(0), 0xfeff)
  assert.match(text, /"带,逗号"/)
  assert.match(text, /\r\n/)
})

test('TSV 文本给 Excel 粘贴', () => {
  const text = internals.toTsvText({ columns: ['a', 'b'], rows: [['1', '2']] })
  assert.equal(text, 'a\tb\n1\t2')
})

test('标题清洗成安全文件名', () => {
  assert.equal(internals.safeName('a/b:c*d?'), 'a_b_c_d_')
  assert.equal(internals.safeName('   '), 'table')
})

test('parseCsvLoose 处理引号与换行', () => {
  const matrix = internals.parseCsvLoose('a,b\n"x,y","两\n行"\n')
  assert.deepEqual(plain(matrix), [['a', 'b'], ['x,y', '两\n行']])
})

test('apply 注册四处界面', () => {
  /** @type {any[]} */
  const records = []
  /** @type {any[]} */
  const tabTypes = []
  /** @type {string[]} */
  const injected = []
  const ctx = {
    effect(fn) {
      return fn()
    },
    slots: {
      inject(name, callback) {
        injected.push(name)
        callback()
      },
      register(descriptor, component) {
        records.push({ descriptor, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition)
        return () => {}
      },
    },
    get() {
      return undefined
    },
  }
  module.apply(ctx)
  assert.equal(tabTypes.length, 1)
  assert.equal(tabTypes[0].kind, internals.TAB_KIND)
  assert.equal(tabTypes[0].priority, 'extension')
  assert.equal(tabTypes[0].multiple, true, 'multiple 必须开：否则宿主只给页面 tab 时，多张表会互相顶掉')
  const keys = records.filter((record) => record.descriptor.name === 'tool.call.toolview').map((record) => record.descriptor.key).sort()
  assert.deepEqual(plain(keys), ['table_open', 'table_render', 'table_update'])
  const panes = records.filter((record) => record.descriptor.name === 'sidebar.right.pane.tab')
  assert.equal(panes.length, 1)
  assert.equal(panes[0].descriptor.key, internals.TAB_ID)
  assert.ok(injected.includes('sidebar.right.pane.tab.title'))
})

test('opener 在折叠侧栏上先 expand，再按会话开 tab', () => {
  const calls = []
  const controller = {
    expand() { calls.push('expand') },
    mounted: { getSnapshot: () => 'session-a' },
    openTab(kind, options) { calls.push(`openTab:${kind}:${JSON.stringify(options?.params ?? null)}`) },
    openTabIn(sessionId, kind, options) { calls.push(`openTabIn:${sessionId}:${kind}:${JSON.stringify(options?.params ?? null)}`) },
  }
  const opener = internals.makeOpener({ get: () => controller }, 'session-a')
  assert.equal(opener({ docId: 'tbl_1' }), true)
  assert.deepEqual(plain(calls), ['expand', 'openTab:table-studio-editor:{"docId":"tbl_1"}'])
})

test('opener 会话不匹配时走 openTabIn', () => {
  const calls = []
  const controller = {
    expand() { calls.push('expand') },
    mounted: { getSnapshot: () => 'session-b' },
    openTab(kind) { calls.push(`openTab:${kind}`) },
    openTabIn(sessionId, kind) { calls.push(`openTabIn:${sessionId}:${kind}`) },
  }
  const opener = internals.makeOpener({ get: () => controller }, 'session-a')
  assert.equal(opener({ docId: 'tbl_2' }), true)
  assert.deepEqual(plain(calls), ['expand', 'openTabIn:session-a:table-studio-editor'])
})

test('opener 只有 openTab 的老侧栏照样能开', () => {
  const calls = []
  const controller = { openTab(kind) { calls.push(kind) } }
  const opener = internals.makeOpener({ get: () => controller }, 'session-a')
  assert.equal(opener({ docId: 'tbl_3' }), true)
  assert.deepEqual(plain(calls), ['table-studio-editor'])
})

test('opener 没有 controller 时返回 false', () => {
  const opener = internals.makeOpener({ get: () => undefined }, 'session-a')
  assert.equal(opener({ docId: 'tbl_1' }), false)
})

test('opener 带 docId 时走资源地址：一表一 tab', () => {
  const calls = []
  const controller = {
    expand() { calls.push('expand') },
    mounted: { getSnapshot: () => 'session-a' },
    openResource(address, options) { calls.push(`openResource:${address}:${JSON.stringify(options?.params ?? null)}`) },
    openTab(kind) { calls.push(`openTab:${kind}`) },
  }
  const opener = internals.makeOpener({ get: () => controller }, 'session-a')
  assert.equal(opener({ docId: 'tbl_1', title: '处罚明细' }), true)
  assert.deepEqual(plain(calls), ['expand', 'openResource:dsh-resource://dsh-table-studio/tbl_1:{"docId":"tbl_1","title":"处罚明细"}'])
  assert.equal(internals.tabTitleOf('dsh-resource://dsh-table-studio/tbl_1'), '处罚明细')
})

test('opener 两次打开同一张表仍是同一个地址', () => {
  const addresses = []
  const controller = {
    openResource(address) { addresses.push(address) },
    openTab() { addresses.push('page-tab') },
  }
  const opener = internals.makeOpener({ get: () => controller }, 'session-a')
  opener({ docId: 'tbl_same' })
  opener({ docId: 'tbl_same' })
  assert.equal(new Set(addresses).size, 1)
  assert.deepEqual(plain(addresses), [
    'dsh-resource://dsh-table-studio/tbl_same',
    'dsh-resource://dsh-table-studio/tbl_same',
  ])
})

test('opener 优先直读 ctx.sidebarRight：门面只给页面 tab 时也不退化成单 tab', () => {
  const calls = []
  const facade = { openTab(kind) { calls.push(`facade:${kind}`) } }
  const controller = {
    mounted: { getSnapshot: () => 'session-a' },
    openResource(address) { calls.push(`openResource:${address}`) },
    openTab(kind) { calls.push(`openTab:${kind}`) },
  }
  const opener = internals.makeOpener({ sidebarRight: controller, get: () => facade }, 'session-a')
  assert.equal(opener({ docId: 'tbl_a', title: '甲表' }), true)
  assert.deepEqual(plain(calls), ['openResource:dsh-resource://dsh-table-studio/tbl_a'])
})

test('sidebarOf：属性优先，其次 reflect.get，最后才是 ctx.get', () => {
  const prop = { openTab() {} }
  const reflect = { openTab() {} }
  const legacy = { openTab() {} }
  assert.equal(internals.sidebarOf({ sidebarRight: prop, reflect: { get: () => reflect }, get: () => legacy }), prop)
  assert.equal(internals.sidebarOf({ reflect: { get: () => reflect }, get: () => legacy }), reflect)
  assert.equal(internals.sidebarOf({ get: () => legacy }), legacy)
  assert.equal(internals.sidebarOf({}), undefined)
  assert.equal(internals.sidebarOf(null), undefined)
  // 读属性会抛的 ctx（没声明 inject）不该把整条路堵死
  const throwing = {
    get sidebarRight() { throw new Error('service not injected') },
    get: () => legacy,
  }
  assert.equal(internals.sidebarOf(throwing), legacy)
})

test('opener 两张不同的表开出两个地址', () => {
  const addresses = []
  const controller = { openResource(address) { addresses.push(address) } }
  const opener = internals.makeOpener({ get: () => controller }, 'session-a')
  opener({ docId: 'tbl_a' })
  opener({ docId: 'tbl_b' })
  assert.equal(new Set(addresses).size, 2)
})

test('opener 会话不匹配时用 openResourceIn 指到本会话', () => {
  const calls = []
  const controller = {
    expand() { calls.push('expand') },
    mounted: { getSnapshot: () => 'session-b' },
    openResource() { calls.push('openResource:wrong-session') },
    openResourceIn(sessionId, address, options) { calls.push(`openResourceIn:${sessionId}:${address}:${JSON.stringify(options?.params ?? null)}`) },
  }
  const opener = internals.makeOpener({ get: () => controller }, 'session-a')
  assert.equal(opener({ docId: 'tbl_9' }), true)
  assert.deepEqual(plain(calls), ['expand', 'openResourceIn:session-a:dsh-resource://dsh-table-studio/tbl_9:{"docId":"tbl_9"}'])
})

test('opener 资源地址抛错时退回页面 tab', () => {
  const calls = []
  const controller = {
    openResource() { throw new Error('no type claims this address') },
    openTab(kind) { calls.push(`openTab:${kind}`) },
  }
  const opener = internals.makeOpener({ get: () => controller }, 'session-a')
  assert.equal(opener({ docId: 'tbl_3' }), true)
  assert.deepEqual(plain(calls), ['openTab:table-studio-editor'])
})

test('docIdOfAddress 只认本插件的资源地址', () => {
  assert.equal(internals.docIdOfAddress('dsh-resource://dsh-table-studio/tbl_a'), 'tbl_a')
  assert.equal(internals.docIdOfAddress('dsh-resource://dsh-table-studio/tbl%20a'), 'tbl a')
  assert.equal(internals.docIdOfAddress('dsh-resource://file/session/x/notes.md'), '')
  assert.equal(internals.docIdOfAddress('sidebar://table-studio-editor'), '')
  assert.equal(internals.docIdOfAddress(''), '')
  assert.equal(internals.docIdOfAddress(undefined), '')
  assert.equal(internals.addressOfDoc('tbl a'), 'dsh-resource://dsh-table-studio/tbl%20a')
})

test('tabCountOf 只数本插件在会话里的 tab', () => {
  const controller = {
    tabsIn(sessionId) {
      return sessionId === 'session-a'
        ? [{ kind: 'table-studio-editor' }, { kind: 'table-studio-editor' }, { kind: 'text' }]
        : []
    },
  }
  assert.equal(internals.tabCountOf(controller, 'session-a'), 2)
  assert.equal(internals.tabCountOf(controller, 'session-b'), 0)
  assert.equal(internals.tabCountOf({}, 'session-a'), undefined)
  assert.equal(internals.tabCountOf(controller, ''), undefined)
  const throwing = { tabsIn() { throw new Error('boom') } }
  assert.equal(internals.tabCountOf(throwing, 'session-a'), undefined)
})

test('TabTitle 用表名，认不出表时退「表格」', () => {
  internals.rememberDocTitle('tbl_titled', '穴位对照')
  const named = internals.TabTitle({ useTabInfo: () => ({ tab: { contentId: 'dsh-resource://dsh-table-studio/tbl_titled' } }) })
  assert.equal(named.props.children, '穴位对照')
  assert.equal(named.props.title, '穴位对照')
  const page = internals.TabTitle({ useTabInfo: () => ({ tab: { contentId: 'sidebar://table-studio-editor' } }) })
  assert.equal(page.props.children, '表格')
  const bare = internals.TabTitle({})
  assert.equal(bare.props.children, '表格')
})

test('TabTitle 从导航参数认表：页面 tab（随机地址）也写得清表名', () => {
  const pageTab = {
    useTabInfo: () => ({
      tab: {
        contentId: 'sidebar://table-studio-editor/3f2a-1b4c',
        navigation: { params: { docId: 'tbl_nav', title: '处罚明细' } },
      },
    }),
  }
  const node = internals.TabTitle(pageTab)
  assert.equal(node.props.children, '处罚明细')
  // 认出的表名进缓存那一步在 effect 里，假 React 不跑 effect，故只验渲染结果
  // 导航参数里没有表名时仍退「表格」，不把随机地址当名字
  const nameless = internals.TabTitle({
    useTabInfo: () => ({ tab: { contentId: 'sidebar://table-studio-editor/9a8b', navigation: { params: { docId: 'tbl_nameless' } } } }),
  })
  assert.equal(nameless.props.children, '表格')
})

test('宽表靠表体横向滚动，列不再压成省略号', () => {
  const css = internals.CSS
  assert.match(css, /\.tst-body \{[\s\S]*?overflow: auto/)
  assert.match(css, /\.tst-body::-webkit-scrollbar[\s\S]*?\{[^}]*height: 10px/)
  assert.match(css, /\.tst-card \.tst-table \{[^}]*table-layout: auto[^}]*width: max-content/)
  assert.match(css, /\.tst-card \.tst-table th,[\s\S]*?min-width: 96px/)
  assert.match(css, /\.tst-preview-body \.tst-table \{[^}]*width: max-content/)
  assert.doesNotMatch(css, /\.tst-card \.tst-table \{ table-layout: fixed/)
})

test('readPalette 在无样式环境也给出兜底色', () => {
  const palette = internals.readPalette()
  assert.match(palette.bg, /^#|rgb/)
  assert.equal(palette.dark, false)
})

test('轮末投影：认 turn/start 与 table_* 的工具调用', () => {
  const definition = internals.tablesDefinition
  assert.equal(definition.kind, 'table-studio')
  assert.deepEqual(plain(definition.match({ type: 'turn/start', data: { turn: 3 } })), { id: '3', role: 'start' })
  assert.deepEqual(plain(definition.match({ type: 'tool/call', data: { turn: 3, name: 'table_render' } })), { id: '3', role: 'update' })
  assert.deepEqual(plain(definition.match({ type: 'tool/call', data: { turn: 3, name: 'table_open' } })), { id: '3', role: 'update' })
  assert.equal(definition.match({ type: 'tool/call', data: { turn: 3, name: 'bash' } }), null)
  assert.equal(definition.match(null), null)
})

test('轮末投影：从 arguments 攒出卡片并去重', () => {
  const definition = internals.tablesDefinition
  const started = definition.start({}, { event: { data: { turn: 3 } } })
  assert.deepEqual(plain(started), { turn: 3, cards: [] })
  const event = {
    type: 'tool/call',
    seq: 12,
    data: {
      turn: 3,
      callId: 'call-9',
      name: 'table_render',
      arguments: JSON.stringify({ title: '穴位对照', columns: ['a', 'b'], rows: [['1', '2']] }),
    },
  }
  const next = definition.update({ state: started }, { event })
  assert.equal(next.cards.length, 1)
  assert.equal(next.cards[0].callId, 'call-9')
  assert.equal(next.cards[0].title, '穴位对照')
  assert.deepEqual(plain(next.cards[0].data.columns), ['a', 'b'])
  const again = definition.update({ state: next }, { event })
  assert.equal(again, next, '同一 callId 不该重复入列')
})

test('轮末投影：坏 JSON 与空参数都跳过', () => {
  const definition = internals.tablesDefinition
  const state = { turn: 1, cards: [] }
  assert.equal(definition.update({ state }, { event: { type: 'tool/call', data: { callId: 'x', arguments: '{坏' } } }), state)
  assert.equal(definition.update({ state }, { event: { type: 'tool/call', data: { callId: '', arguments: '{}' } } }), state)
  assert.equal(definition.update({ state }, { event: { type: 'tool/call', data: { callId: 'y', arguments: '{}' } } }), state)
})

test('轮末投影：match 认 tool/result，没 callId 或不认', () => {
  const definition = internals.tablesDefinition
  const ok = definition.match({ type: 'tool/result', data: { turn: 7, message: { source: { callId: 'c1' } } } })
  assert.deepEqual(plain(ok), { id: '7', role: 'update' })
  // turn 不是数就别接：否则投影会多出一个 'undefined' 键
  assert.equal(definition.match({ type: 'tool/result', data: { message: { source: { callId: 'c1' } } } }), null)
  assert.equal(definition.match({ type: 'tool/result', data: { turn: 7, message: {} } }), null)
  assert.equal(definition.match({ type: 'tool/result', data: { turn: 7 } }), null)
  assert.equal(definition.match({ type: 'tool/result' }), null)
})

test('轮末投影：tool/result 把表 id 回填进卡，点得动「在画布里编辑」', () => {
  const definition = internals.tablesDefinition
  const started = definition.start({}, { event: { type: 'turn/start', data: { turn: 7 } } })
  let state = definition.update({ state: started }, {
    event: {
      type: 'tool/call', data: {
        turn: 7, callId: 'call-1', name: 'table_render',
        arguments: JSON.stringify({ title: '甲表', columns: ['a', 'b'], rows: [['1', '2']] }),
      },
    },
  })
  assert.equal(state.cards.length, 1)
  assert.equal(state.cards[0].id, '', '只有参数时本来没有 id')
  assert.equal(state.cards[0].data !== null, true)
  state = definition.update({ state }, {
    event: {
      type: 'tool/result', data: {
        turn: 7,
        message: {
          source: { callId: 'call-1' },
          content: [{ type: 'text', text: '「甲表」 · 2 列 × 1 行 · id tbl_20261127_aaaaaa' }],
        },
      },
    },
  })
  assert.equal(state.cards.length, 1)
  assert.equal(state.cards[0].id, 'tbl_20261127_aaaaaa')
  assert.deepEqual(plain(state.cards[0].data.rows), [['1', '2']], '回填 id 不许动数据')
  // 结果重放不该把已有 id 的卡再搅一遍
  const again = definition.update({ state }, {
    event: {
      type: 'tool/result', data: {
        turn: 7,
        message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'id tbl_20261127_bbbbbb' }] },
      },
    },
  })
  assert.equal(again.cards[0].id, 'tbl_20261127_aaaaaa')
})

test('轮末投影：tool/result 只填自己那些卡', () => {
  const definition = internals.tablesDefinition
  const state = { turn: 7, cards: [{ callId: 'call-1', id: '', title: '甲表', note: '', data: { columns: ['a'], rows: [['1']] } }] }
  const untouched = definition.update({ state }, {
    event: {
      type: 'tool/result', data: {
        turn: 7,
        message: { source: { callId: '别的调用' }, content: [{ type: 'text', text: 'id tbl_20261127_zzzzzz' }] },
      },
    },
  })
  assert.equal(untouched, state, 'callId 对不上的结果不该碰这张卡')
  const noId = definition.update({ state }, {
    event: {
      type: 'tool/result', data: {
        turn: 7,
        message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: '没带 id 的一句话' }] },
      },
    },
  })
  assert.equal(noId.cards[0].id, '', '结果里没有 id 就留着空，别瞎编')
})

test('轮末卡把表 id 传给 TableCardView：点放大后开得出对应表', () => {
  const cards = [{
    callId: 'c1', id: 'tbl_20261127_aaaaaa', title: '甲表', note: '',
    data: { columns: ['a'], rows: [['1']] },
  }]
  const node = internals.TablesTail({ sessionId: 'session-a', turn: { data: { get: () => ({ cards }) } } })
  const item = node.props.children[0]
  const view = item.props.children
  assert.equal(view.props.id, 'tbl_20261127_aaaaaa')
  assert.equal(view.props.title, '甲表')
  assert.equal(typeof view.props.openEditor, 'function')
})

test('resolvePanelDoc：认表只认参数与资源地址，不拿会话当前表顶替', () => {
  const resolve = internals.resolvePanelDoc
  // 导航参数最可信
  assert.deepEqual(plain(resolve({ docId: 'tbl_a' }, 'sidebar://table-studio-editor/3f2a')), { docId: 'tbl_a', phase: 'ready' })
  // 参数空了（刷新后）就靠 tab 的资源地址
  assert.deepEqual(plain(resolve({}, 'dsh-resource://dsh-table-studio/tbl_b')), { docId: 'tbl_b', phase: 'ready' })
  assert.deepEqual(plain(resolve(undefined, 'dsh-resource://dsh-table-studio/tbl_b')), { docId: 'tbl_b', phase: 'ready' })
  // 两样都没有：老实说不知道，绝不退回「会话当前表」——那永远是最后渲染的一张
  assert.deepEqual(plain(resolve({}, 'sidebar://table-studio-editor/9a8b')), { docId: '', phase: 'empty' })
  assert.deepEqual(plain(resolve({ title: '某张表' }, '')), { docId: '', phase: 'empty' })
  assert.deepEqual(plain(resolve(undefined, '')), { docId: '', phase: 'empty' })
  // 参数里 docId 是空串时也不该当成有
  assert.deepEqual(plain(resolve({ docId: '' }, 'dsh-resource://dsh-table-studio/tbl_c')), { docId: 'tbl_c', phase: 'ready' })
})

test('reportInventory：资源 tab 报 id，页面 tab 报空壳', () => {
  const seen = []
  const controller = {
    tabsIn: () => [
      { kind: internals.TAB_KIND, contentId: 'dsh-resource://dsh-table-studio/tbl_a' },
      { kind: internals.TAB_KIND, contentId: 'sidebar://table-studio-editor/3f2a' },
      { kind: '别的插件', contentId: 'whatever' },
    ],
  }
  // report 走的是 vm 里那个 fetch，得把 vm 上下文里的换掉才拦得到。
  const original = context.fetch
  context.fetch = async (_url, options) => {
    seen.push(JSON.parse(String(options?.body ?? '{}')))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    internals.reportInventory(controller, 'session-a')
  } finally {
    context.fetch = original
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'tab-inventory')
  assert.equal(seen[0].count, 2)
  assert.equal(seen[0].note, 'tbl_a,空壳')
})

test('reportInventory：没有自己的 tab 就不吭声', () => {
  const seen = []
  const original = context.fetch
  context.fetch = async (_url, options) => {
    seen.push(JSON.parse(String(options?.body ?? '{}')))
    return { ok: true, json: async () => ({ ok: true }) }
  }
  try {
    internals.reportInventory({ tabsIn: () => [] }, 'session-a')
    internals.reportInventory({ tabsIn: () => [{ kind: '别的插件' }] }, 'session-a')
    internals.reportInventory(undefined, 'session-a')
    internals.reportInventory({ tabsIn: () => [{ kind: internals.TAB_KIND }] }, '')
  } finally {
    context.fetch = original
  }
  assert.equal(seen.length, 0)
})

test('shellTabsOf：只挑认不出表的空壳', () => {
  const shells = internals.shellTabsOf([
    { kind: internals.TAB_KIND, contentId: 'dsh-resource://dsh-table-studio/tbl_a' },
    { kind: internals.TAB_KIND, contentId: 'sidebar://table-studio-editor/3f2a' },
    { kind: internals.TAB_KIND, contentId: '' },
    { kind: '别的插件', contentId: 'whatever' },
  ])
  assert.equal(shells.length, 2)
  assert.deepEqual(plain(shells.map((tab) => tab.contentId)), ['sidebar://table-studio-editor/3f2a', ''])
  assert.deepEqual(plain(internals.shellTabsOf(undefined)), [])
  assert.deepEqual(plain(internals.shellTabsOf('不是数组')), [])
})

test('轮末投影：buildLocationData 挂到 turn 上', () => {
  const definition = internals.tablesDefinition
  assert.equal(definition.buildLocationData({ state: { turn: 1, cards: [] } }, 'turn', null), null)
  const cards = [{ callId: 'c1', title: 't' }]
  const location = definition.buildLocationData({ state: { turn: 4, cards } }, 'turn', null)
  assert.equal(location.kind, 'turn')
  assert.equal(location.turn, 4)
  assert.equal(location.key, 'table-studio')
  assert.equal(location.value.cards, cards)
  assert.equal(definition.buildLocationData({ state: { turn: 4, cards } }, 'session', null), null)
})

test('markTailRendered 叫醒订阅者并去重', () => {
  assert.equal(internals.markTailRendered(['a']), true)
  assert.equal(internals.markTailRendered(['a']), false)
  assert.equal(internals.tailRendered.has('a'), true)
  assert.equal(internals.markTailRendered(null), false)
})

test('overlaySrc 按需拼 doc 与 session', () => {
  assert.equal(internals.overlaySrc('tbl_1', 's1'), '/dsh-table-studio/editor?doc=tbl_1&session=s1')
  assert.equal(internals.overlaySrc('', 's1'), '/dsh-table-studio/editor?session=s1')
  assert.equal(internals.overlaySrc('tbl_1', ''), '/dsh-table-studio/editor?doc=tbl_1')
  assert.equal(internals.overlaySrc('', ''), '/dsh-table-studio/editor')
})

test('autoOpenOnce 每个浏览器会话只开一次', () => {
  const store = new Map()
  fakeWindow.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
  }
  let calls = 0
  const opener = () => { calls += 1; return true }
  assert.equal(internals.autoOpenOnce('tbl_auto_1', opener), true)
  assert.equal(calls, 1)
  assert.equal(internals.autoOpenOnce('tbl_auto_1', opener), false, '第二次不该再开')
  assert.equal(calls, 1)
  assert.equal(internals.autoOpenOnce('tbl_auto_2', () => false), false, '开不起来不该记账')
  delete fakeWindow.sessionStorage
})

test('autoOpenOnce 对空 id / 没 opener 直接放过', () => {
  assert.equal(internals.autoOpenOnce('', () => true), false)
  assert.equal(internals.autoOpenOnce('tbl_x', null), false)
})

test('onColor 按底色亮度选前景', () => {
  assert.equal(internals.onColor('#ffffff'), '#1f2329')
  assert.equal(internals.onColor('#000000'), '#ffffff')
  assert.equal(internals.onColor('#4d6bfe'), '#ffffff')
  assert.equal(internals.onColor('不是颜色'), '#ffffff')
})

test('parseColor 认三种写法', () => {
  assert.deepEqual(plain(internals.parseColor('#abc')), [170, 187, 204])
  assert.deepEqual(plain(internals.parseColor('#4D6BFE')), [77, 107, 254])
  assert.deepEqual(plain(internals.parseColor('rgb(1, 2, 3)')), [1, 2, 3])
  assert.equal(internals.parseColor(''), null)
})

await testAsync('fileActionsOf 只认带 save 的服务', async () => {
  assert.equal(internals.fileActionsOf(undefined), null)
  assert.equal(internals.fileActionsOf({ get: () => ({}) }), null)
  const service = { save() {} }
  assert.equal(internals.fileActionsOf({ get: () => service }), service)
})

await testAsync('saveFileSilently 走 fileActions 的 download 模式并回传路径', async () => {
  const calls = []
  const service = {
    save: async (source, mode) => {
      calls.push({ source, mode })
      return { status: 'saved', path: 'C:/Users/x/Downloads/穴位.csv' }
    },
  }
  const result = await internals.saveFileSilently({ get: () => service }, { size: 1, type: 'text/csv' }, '穴位.csv', 'text/csv')
  assert.equal(result.ok, true)
  assert.equal(result.status, 'saved')
  assert.equal(result.path, 'C:/Users/x/Downloads/穴位.csv')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mode, 'download', '必须是 download 模式——saveAs 才会弹选择框')
  assert.equal(calls[0].source.name, '穴位.csv')
  assert.equal(calls[0].source.mediaType, 'text/csv')
  assert.equal(calls[0].source.url, 'blob:mock')
})

await testAsync('saveFileSilently 区分取消与失败', async () => {
  const canceled = await internals.saveFileSilently({ get: () => ({ save: async () => ({ status: 'cancelled' }) }) }, { size: 1 }, 'a.csv')
  assert.equal(canceled.ok, false)
  assert.equal(canceled.canceled, true)
  const failed = await internals.saveFileSilently({ get: () => ({ save: async () => { throw new Error('boom') } }) }, { size: 1 }, 'a.csv')
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'boom')
})

await testAsync('saveFileSilently 没有 fileActions 时退回浏览器下载', async () => {
  const result = await internals.saveFileSilently(null, { size: 1 }, 'a.csv')
  assert.equal(result.ok, true)
  assert.equal(result.status, 'requested')
  assert.equal(result.code, 'fallback-download')
})

await testAsync('savedHint 优先给绝对路径，其次文件名', async () => {
  assert.equal(internals.savedHint({ status: 'saved', path: 'C:/dl/a.csv', name: 'a.csv' }), 'C:/dl/a.csv')
  assert.equal(internals.savedHint({ status: 'saved', name: 'a.csv' }), 'a.csv')
  assert.equal(internals.savedHint({ status: 'requested', name: 'a.csv' }), '')
})

console.log(`client.test.js: ${passed} passed`)
