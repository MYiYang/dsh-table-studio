/**
 * 表格模型单测：归一化、限额、序列化。
 */
import assert from 'node:assert/strict'
import {
  LIMITS,
  TableError,
  assertId,
  cellText,
  newId,
  normalizeTable,
  tableFromCsv,
  tableShape,
  tableToCsv,
  tableToMarkdown,
} from '../lib/model.js'

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

/** @param {() => void} fn - 期望抛 TableError 的调用。 @param {string} code - 期望的错误码。 */
function failsWith(fn, code) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof TableError, `期望 TableError，实得 ${error?.name}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail('没有抛错')
}

console.log('model.test.js')

test('列 + 行：补齐矩形并裁尾部空行', () => {
  const table = normalizeTable({
    columns: ['位置', '中医名称', '对应西医常见'],
    rows: [['合谷', '虎口', '头痛'], ['足三里', '下陵', ''], ['', '', '']],
  })
  assert.equal(table.columns.length, 3)
  assert.equal(table.rows.length, 2, '尾部整行空白应被裁掉')
  assert.deepEqual(table.rows[1], ['足三里', '下陵', ''])
})

test('短行补齐到列数', () => {
  const table = normalizeTable({ columns: ['a', 'b', 'c'], rows: [['x']] })
  assert.deepEqual(table.rows[0], ['x', '', ''])
})

test('空表头补成「列N」', () => {
  const table = normalizeTable({ columns: ['', '名称'], rows: [['1', '2']] })
  assert.deepEqual(table.columns, ['列1', '名称'])
})

test('只给 rows 时第一行当表头', () => {
  const table = normalizeTable({ rows: [['位置', '名称'], ['合谷', '虎口']] })
  assert.deepEqual(table.columns, ['位置', '名称'])
  assert.deepEqual(table.rows, [['合谷', '虎口']])
})

test('csv 输入：首行表头', () => {
  const table = normalizeTable({ csv: '位置,名称\n"合谷, 虎口",大肠经\n' })
  assert.deepEqual(table.columns, ['位置', '名称'])
  assert.deepEqual(table.rows, [['合谷, 虎口', '大肠经']])
})

test('数字与 null 转文本', () => {
  assert.equal(cellText(12.5), '12.5')
  assert.equal(cellText(null), '')
  assert.equal(cellText(true), 'TRUE')
  // null 变空串；而「整行全空」属于尾部噪音，归一化时会裁掉。
  const table = normalizeTable({ columns: ['n'], rows: [[1], [2.5], [null]] })
  assert.deepEqual(table.rows, [['1'], ['2.5']])
  const kept = normalizeTable({ columns: ['a', 'b'], rows: [[1, null], [2, 3]] })
  assert.deepEqual(kept.rows, [['1', ''], ['2', '3']])
})

test('标题默认「表格」，超长截断', () => {
  assert.equal(normalizeTable({ columns: ['a'], rows: [] }).title, '表格')
  const long = normalizeTable({ columns: ['a'], rows: [], title: 'x'.repeat(200) })
  assert.equal(long.title.length, LIMITS.titleLength)
})

test('空内容报 empty-table', () => {
  failsWith(() => normalizeTable({}), 'empty-table')
})

test('列数超限', () => {
  failsWith(() => normalizeTable({ columns: Array.from({ length: LIMITS.columns + 1 }, (_, i) => `c${i}`) }), 'too-many-columns')
})

test('行数超限', () => {
  const rows = Array.from({ length: LIMITS.rows + 1 }, () => ['1'])
  failsWith(() => normalizeTable({ columns: ['a'], rows }), 'too-many-rows')
})

test('单元格超长', () => {
  failsWith(() => normalizeTable({ columns: ['a'], rows: [['x'.repeat(LIMITS.cellLength + 1)]] }), 'cell-too-long')
})

test('id 校验挡住穿越', () => {
  assert.equal(assertId('tbl_20261118_ab12cd'), 'tbl_20261118_ab12cd')
  failsWith(() => assertId('../etc/passwd'), 'bad-id')
  failsWith(() => assertId(''), 'bad-id')
})

test('newId 形状', () => {
  const id = newId('tbl', new Date(2026, 10, 18))
  assert.match(id, /^tbl_20261118_[0-9a-f]{6}$/)
})

test('CSV 往返', () => {
  const table = normalizeTable({ columns: ['a', 'b'], rows: [['1', '带,逗号'], ['2', '带"引号"']] })
  const csv = tableToCsv(table)
  const back = tableFromCsv(csv)
  assert.deepEqual(back.columns, table.columns)
  assert.deepEqual(back.rows, table.rows)
})

test('CSV 导出可带 BOM', () => {
  const table = normalizeTable({ columns: ['位置'], rows: [['合谷']] })
  assert.equal(tableToCsv(table, { bom: true }).codePointAt(0), 0xfeff)
})

test('Markdown 转义竖线', () => {
  const table = normalizeTable({ columns: ['a|b'], rows: [['x|y']] })
  assert.match(tableToMarkdown(table), /a\\\|b/)
  assert.match(tableToMarkdown(table), /x\\\|y/)
})

test('shape 文案', () => {
  const table = normalizeTable({ columns: ['a', 'b'], rows: [['1', '2'], ['3', '4']] })
  assert.equal(tableShape(table), '2 列 × 2 行')
})

console.log(`model.test.js: ${passed} passed`)
