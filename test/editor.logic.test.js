/**
 * 编辑器页逻辑单测：不用 jsdom，拿一个最小假 DOM 把 editor.js 跑起来。
 *
 * 只验跟「Excel 风 / 多表 / 格式」相关、且不依赖真 canvas 的纯逻辑：
 *   - 文档装载与快照（columns/rows/grid/skin）
 *   - CSV 文本（BOM、CRLF、表头在第一行）
 *   - `data`（带格式的单元格对象）→ `celldata` 的压缩转换
 *   - 工作表还原时补默认值、保留多表与格式
 *   - 主题消息落到 CSS 变量
 *
 * 真渲染（工具条 / 公式栏 / 工作表标签是否画出来）在 test/editor.dom.test.js
 * 与手工 headless 浏览器验证里，不在这一层。
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

/** 最小假 DOM：只给 editor.js 用得到的那些。 */
function makeDocument() {
  const attrs = {}
  const cssVars = {}
  const documentElement = {
    style: { setProperty(name, value) { cssVars[name] = value } },
    setAttribute(name, value) { attrs[name] = String(value) },
    getAttribute(name) { return attrs[name] ?? null },
    attrs,
    cssVars,
  }
  return {
    documentElement,
    body: { appendChild() {}, dataset: {}, classList: { contains: () => false } },
    readyState: 'complete',
    getElementById() { return null },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      return {
        tag,
        className: '',
        style: {},
        children: [],
        appendChild(node) { this.children.push(node) },
        setAttribute() {},
        remove() {},
        click() {},
        querySelector() { return null },
        getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0 } },
      }
    },
  }
}

const doc = makeDocument()
const listeners = new Map()
const windowObject = {
  parent: null,
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(handler)
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  },
  dispatchEvent() { return true },
  postMessage() {},
  setTimeout,
  clearTimeout,
  setInterval() { return 0 },
  clearInterval() {},
}
windowObject.parent = windowObject

const DOC = {
  ok: true,
  id: 'tbl_20261119_logic',
  title: '穴位对照',
  updatedAt: '2026-11-19T00:00:00.000Z',
  data: {
    columns: ['位置', '中医名称', '对应西医常见'],
    rows: [['合谷', '虎口', '头痛'], ['足三里', '下陵', '胃痛']],
  },
}

const context = vm.createContext({
  window: windowObject,
  document: doc,
  location: { search: '?doc=tbl_20261119_logic&session=s1' },
  navigator: {},
  URLSearchParams,
  URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
  Blob: class Blob { constructor(parts, options) { this.parts = parts; this.type = options?.type ?? '' } },
  fetch: async (url) => ({
    status: 200,
    json: async () => (String(url).includes('/doc/') ? DOC : { ok: true }),
  }),
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  console,
})

vm.runInContext(readFileSync(fileURLToPath(new URL('../assets/editor.js', import.meta.url)), 'utf8'), context, {
  filename: 'editor.js',
})

const editor = windowObject.__tsEditor

/** 等一拍，让 boot() 的 fetch 链走完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

console.log('editor.logic.test.js')

await settle()

test('载入文档后快照给出 columns / rows / 白纸', () => {
  const snapshot = editor.snapshot()
  assert.equal(snapshot.id, DOC.id)
  assert.deepEqual([...snapshot.columns], ['位置', '中医名称', '对应西医常见'])
  assert.equal(snapshot.rows.length, 2)
  assert.deepEqual([...snapshot.rows[1]], ['足三里', '下陵', '胃痛'])
  assert.equal(snapshot.skin, 'paper', '纸面固定白纸，Excel 风')
  assert.equal(snapshot.grid, 'jspreadsheet', '没有真组件时退回 jspreadsheet')
})

test('CSV 文本第一行是表头，带 BOM 与 CRLF', () => {
  const text = editor.csvText()
  assert.equal(text.codePointAt(0), 0xfeff)
  assert.match(text, /位置,中医名称,对应西医常见\r\n/)
  assert.match(text, /合谷,虎口,头痛\r\n/)
})

test('data → celldata 保留格式（加粗、字色、数字类型）', () => {
  const cells = editor.dataToCelldata([
    [{ v: '甲', m: '甲', bl: 1, fc: '#ff0000', ct: { fa: 'General', t: 's' } }],
    [{ v: 42, m: '42', ct: { fa: 'General', t: 'n' } }, null, ''],
  ])
  assert.equal(cells.length, 2)
  assert.equal(cells[0].r, 0)
  assert.equal(cells[0].v.bl, 1)
  assert.equal(cells[0].v.fc, '#ff0000')
  assert.equal(cells[1].c, 0)
  assert.equal(cells[1].v.v, 42)
})

test('compactSheet：压掉运行时状态，只留可还原字段', () => {
  const sheet = editor.compactSheet({
    name: '表格',
    order: 0,
    status: 1,
    row: 30,
    column: 8,
    config: { columnlen: { 0: 120 } },
    data: [[{ v: '甲', m: '甲', bl: 1 }]],
    luckysheet_select_save: [{ row: [0, 0], column: [0, 0] }],
    id: 'runtime-id',
    zoomRatio: 1,
  })
  assert.equal(sheet.name, '表格')
  assert.equal(sheet.celldata.length, 1)
  assert.equal(sheet.celldata[0].v.bl, 1)
  assert.equal(sheet.config.columnlen[0], 120)
  assert.equal('luckysheet_select_save' in sheet, false, '选区这类运行时状态不该落盘')
  assert.equal('id' in sheet, false, '组件内部 id 每次重开都会重新生成')
})

test('renderSheets：多表还原，坏数据退回单张空表', () => {
  const sheets = editor.renderSheets([
    { name: '表一', status: 1, celldata: [{ r: 0, c: 0, v: { v: '甲', m: '甲' } }], config: {} },
    { name: 'Sheet2', status: 0, data: [[{ v: '乙', m: '乙', bl: 1 }]], config: {} },
  ])
  assert.equal(sheets.length, 2)
  assert.equal(sheets[0].name, '表一')
  assert.equal(sheets[1].name, 'Sheet2')
  assert.equal(sheets[1].celldata[0].v.bl, 1, 'data 里的格式要带回来')
  assert.equal(sheets[1].status, 0)
  assert.equal(sheets[1].defaultColWidth, 110)

  const fallback = editor.renderSheets([{ nope: true }])
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].name, '表格')
})

test('sheetsToMatrix：celldata 稀疏表补成矩形', () => {
  const matrix = editor.sheetsToMatrix([{
    celldata: [
      { r: 0, c: 0, v: { v: 'A', m: 'A' } },
      { r: 1, c: 1, v: { v: 'B', m: 'B' } },
    ],
  }])
  assert.equal(matrix.length, 2)
  assert.equal(matrix[0][1], '')
  assert.equal(matrix[1][1], 'B')
})

test('主题消息写到 CSS 变量，纸面仍是白纸', () => {
  const handler = (listeners.get('message') ?? [])[0]
  assert.equal(typeof handler, 'function', '应注册 message 监听')
  handler({ data: { __ts: 'theme', palette: { accent: '#112233', bg: '#0a0a0a', dark: true } } })
  assert.equal(doc.documentElement.cssVars['--ts-accent'], '#112233')
  assert.equal(doc.documentElement.cssVars['--ts-bg'], '#0a0a0a')
  assert.equal(doc.documentElement.getAttribute('data-ts-theme'), 'dark')
  assert.equal(doc.documentElement.getAttribute('data-ts-skin'), 'paper')
})

test('保存请求会带上 sheets（若有 fortune 数据）', () => {
  // 这一层没有真组件，grid=jspreadsheet；sheetsPayload 应明确返回 undefined（不动已有格式）。
  assert.equal(editor.sheetsPayload(), undefined)
})

test('shapeFromMatrix：表头上方插了空行，表头仍是原表头', () => {
  const shape = editor.shapeFromMatrix([
    ['', '', ''],
    ['位置', '中医名称', '对应西医常见'],
    ['合谷', '虎口', '头痛'],
  ])
  assert.deepEqual([...shape.columns], ['位置', '中医名称', '对应西医常见'])
  assert.equal(shape.rows.length, 1)
  assert.deepEqual([...shape.rows[0]], ['合谷', '虎口', '头痛'])
})

test('shapeFromMatrix：A 列左侧插了空列，空列不算真列', () => {
  const shape = editor.shapeFromMatrix([
    ['', '位置', '中医名称'],
    ['', '合谷', '虎口'],
  ])
  assert.deepEqual([...shape.columns], ['位置', '中医名称'])
  assert.deepEqual([...shape.rows[0]], ['合谷', '虎口'])
})

test('shapeFromMatrix：中间空行保留，尾部空行/空列裁掉', () => {
  const shape = editor.shapeFromMatrix([
    ['甲', '乙', '', ''],
    ['1', '2', '', ''],
    ['', '', '', ''],
    ['3', '4', '', ''],
    ['', '', '', ''],
    ['', '', '', ''],
  ])
  assert.deepEqual([...shape.columns], ['甲', '乙'])
  assert.deepEqual([...shape.rows[0]], ['1', '2'])
  assert.deepEqual([...shape.rows[1]], ['', ''])
  assert.deepEqual([...shape.rows[2]], ['3', '4'])
  assert.equal(shape.rows.length, 3)
})

test('shapeFromMatrix：普通表不改变', () => {
  const shape = editor.shapeFromMatrix([
    ['位置', '中医名称'],
    ['合谷', '虎口'],
    ['足三里', '下陵'],
  ])
  assert.deepEqual([...shape.columns], ['位置', '中医名称'])
  assert.equal(shape.rows.length, 2)
})

test('renderSheets：表头上方多了空行，渲染时拉回 A1', () => {
  const sheets = editor.renderSheets([{
    name: '表格',
    status: 1,
    config: { columnlen: { 0: 120, 1: 90 }, rowlen: { 1: 30 } },
    celldata: [
      { r: 1, c: 0, v: { v: '位置', m: '位置', bl: 1 } },
      { r: 1, c: 1, v: { v: '名称', m: '名称', bl: 1 } },
      { r: 2, c: 0, v: { v: '合谷', m: '合谷' } },
      { r: 2, c: 1, v: { v: '虎口', m: '虎口' } },
    ],
  }])
  const sheet = sheets[0]
  const cells = sheet.celldata
  assert.equal(cells[0].r, 0, '表头应回到第一行')
  assert.equal(cells[0].c, 0)
  assert.equal(cells[0].v.v, '位置')
  assert.equal(cells[1].r, 0)
  assert.equal(cells[2].r, 1, '数据行跟着上移')
  assert.equal(sheet.config.columnlen[0], 120, '列宽跟着左移/保留')
  assert.equal(sheet.config.rowlen[0], 30, '行高跟着上移')
})

test('renderSheets：A 列左侧多了空列，渲染时拉回 A1', () => {
  const sheets = editor.renderSheets([{
    name: '表格',
    status: 1,
    celldata: [
      { r: 0, c: 1, v: { v: '位置', m: '位置' } },
      { r: 0, c: 2, v: { v: '名称', m: '名称' } },
      { r: 1, c: 1, v: { v: '合谷', m: '合谷' } },
      { r: 1, c: 2, v: { v: '虎口', m: '虎口' } },
    ],
  }])
  const cells = sheets[0].celldata
  assert.equal(cells[0].r, 0)
  assert.equal(cells[0].c, 0)
  assert.equal(cells[0].v.v, '位置')
  assert.equal(cells[2].c, 0)
})

test('renderSheets：本来就在 A1 的表格不动', () => {
  const sheets = editor.renderSheets([{
    name: '表格',
    status: 1,
    celldata: [
      { r: 0, c: 0, v: { v: '甲', m: '甲' } },
      { r: 1, c: 0, v: { v: '1', m: '1' } },
    ],
    config: { columnlen: { 0: 88 } },
  }])
  assert.equal(sheets[0].celldata[0].r, 0)
  assert.equal(sheets[0].celldata[0].c, 0)
  assert.equal(sheets[0].config.columnlen[0], 88)
})

test('renderSheets：冻结/图片/筛选等附件原样带回', () => {
  const sheets = editor.renderSheets([{
    name: '表格',
    status: 1,
    celldata: [{ r: 0, c: 0, v: { v: '甲', m: '甲' } }],
    frozen: { type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } },
    images: [{ id: 'img1' }],
    luckysheet_filter_save: [{ range: { row: [0, 2] } }],
    dataVerification: { '0_0': { type: 'number' } },
  }])
  const sheet = sheets[0]
  assert.deepEqual(sheet.frozen, { type: 'rangeRow', range: { row_focus: 0, column_focus: 0 } })
  assert.equal(sheet.images[0].id, 'img1')
  assert.equal(Array.isArray(sheet.luckysheet_filter_save), true)
  assert.equal(sheet.dataVerification['0_0'].type, 'number')
})

test('padShape：补行补列且行宽对齐', () => {
  const base = { columns: ['甲', '乙'], rows: [['1', '2'], ['', '']] }
  const padded = editor.padShape(base, 1, 1)
  assert.deepEqual([...padded.columns], ['甲', '乙', '列3'])
  assert.deepEqual([...padded.rows[0]], ['1', '2', ''])
  assert.deepEqual([...padded.rows[2]], ['', '', ''])
  assert.equal(padded.rows.length, 3)
})

test('countTrailingBlankRows / countTrailingBlankColumns 只数尾部空白', () => {
  assert.equal(editor.countTrailingBlankRows([['甲'], ['1'], [''], ['']]), 2)
  assert.equal(editor.countTrailingBlankRows([['甲'], ['']]), 1)
  assert.equal(editor.countTrailingBlankColumns(['甲', '乙', ''], [['1', '2', ''], ['3', '4', '']]), 1)
  assert.equal(editor.countTrailingBlankColumns(['甲', '乙'], [['1', '2']]), 0)
})

test('trackTrailingExtension：尾部插行只加补白计数，中间插行不动', () => {
  const before = [{ row: 30, column: 8, celldata: [
    { r: 0, c: 0, v: { m: '甲' } }, { r: 1, c: 0, v: { m: '1' } },
  ] }]
  const tail = [{ row: 31, column: 8, celldata: [
    { r: 0, c: 0, v: { m: '甲' } }, { r: 1, c: 0, v: { m: '1' } },
  ] }]
  editor.trailingExtraReset()
  editor.trackTrailingExtension(before, tail)
  assert.equal(editor.trailingExtra().rows, 1)
  const middle = [{ row: 31, column: 8, celldata: [
    { r: 0, c: 0, v: { m: '甲' } }, { r: 2, c: 0, v: { m: '1' } },
  ] }]
  editor.trackTrailingExtension(tail, middle)
  assert.equal(editor.trailingExtra().rows, 1, '中间插行不应动补白计数')
})

test('trackTrailingExtension：往补出来的空行里打字后计数回退', () => {
  const before = [{ row: 31, column: 8, celldata: [
    { r: 0, c: 0, v: { m: '甲' } }, { r: 1, c: 0, v: { m: '1' } },
  ] }]
  const tail = [{ row: 32, column: 8, celldata: [
    { r: 0, c: 0, v: { m: '甲' } }, { r: 1, c: 0, v: { m: '1' } },
  ] }]
  const typed = [{ row: 32, column: 8, celldata: [
    { r: 0, c: 0, v: { m: '甲' } }, { r: 1, c: 0, v: { m: '1' } }, { r: 2, c: 0, v: { m: '新' } },
  ] }]
  editor.trailingExtraReset()
  editor.trackTrailingExtension(before, tail)
  assert.equal(editor.trailingExtra().rows, 1)
  editor.trackTrailingExtension(tail, typed)
  assert.equal(editor.trailingExtra().rows, 0, '往补出来的空行里打字后补白计数应回退')
})

test('parseInsertMenuItem：认得出四个插入项，别把「复制 / 删除」当插入', () => {
  assert.deepEqual({ ...editor.parseInsertMenuItem('向下插入  行') }, { type: 'row', direction: 'rightbottom', before: false })
  assert.deepEqual({ ...editor.parseInsertMenuItem('向上插入  行') }, { type: 'row', direction: 'lefttop', before: true })
  assert.deepEqual({ ...editor.parseInsertMenuItem('向右插入  列') }, { type: 'column', direction: 'rightbottom', before: false })
  assert.deepEqual({ ...editor.parseInsertMenuItem('向左插入  列') }, { type: 'column', direction: 'lefttop', before: true })
  assert.equal(editor.parseInsertMenuItem('复制'), null)
  assert.equal(editor.parseInsertMenuItem('删除选中行'), null)
  assert.equal(editor.parseInsertMenuItem(''), null)
  assert.equal(editor.parseInsertMenuItem(null), null)
})

test('insertRowOrColumn：没有组件实例时老实返回 false，不抛错', () => {
  assert.equal(editor.insertRowOrColumn('row', 1, 'rightbottom'), false)
  assert.equal(editor.insertRowOrColumnAt('row', 1, 1, 'rightbottom'), false)
  assert.equal(editor.insertRowOrColumnAt('column', 1, 1, 'lefttop'), false)
})

test('reportCrash：记进 crashLog，最多留 12 条，且不抛错', () => {
  for (let i = 0; i < 15; i += 1) editor.reportCrash('unit-test', new Error(`boom-${i}`))
  const log = editor.crashLog()
  assert.equal(log.length, 12, '只留最早进队列的 12 条（后续不再堆）')
  assert.equal(log[0].kind, 'unit-test')
  assert.match(log[0].message, /boom-0/)
  assert.doesNotThrow(() => editor.reportCrash('unit-test-plain', 'plain message'))
})

test('healState：初始没抢救过，也不会自己乱重建', () => {
  const heal = editor.healState()
  assert.equal(heal.healing, false)
  assert.equal(heal.blankTicks, 0)
  assert.equal(typeof heal.attempts, 'number')
})

console.log(`editor.logic.test.js: ${passed} passed`)
process.exit(0)
