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
