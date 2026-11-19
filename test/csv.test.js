/**
 * CSV 编解码单测：跑 `node test/csv.test.js`。
 *
 * 只测「会坏的地方」：字段里的逗号与换行、引号转义、CRLF、制表符分隔、
 * GBK 中文、BOM、以及转义后再解析回来的往返一致性。
 */
import assert from 'node:assert/strict'
import { detectDelimiter, detectEncoding, decodeText, parseCsv, toCsv } from '../lib/csv.js'

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

console.log('csv.test.js')

test('普通两行', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']])
})

test('字段里有逗号', () => {
  assert.deepEqual(parseCsv('a,b\n"x,y",2\n'), [['a', 'b'], ['x,y', '2']])
})

test('字段里有换行', () => {
  assert.deepEqual(parseCsv('a,b\n"第一行\n第二行",2\n'), [['a', 'b'], ['第一行\n第二行', '2']])
})

test('双引号转义', () => {
  assert.deepEqual(parseCsv('a\n"他说""好"""\n'), [['a'], ['他说"好"']])
})

test('CRLF 与尾部空行', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n\r\n'), [['a', 'b'], ['1', '2'], ['']])
})

test('自动认制表符', () => {
  assert.equal(detectDelimiter('位置\t中医名称\n合谷\t虎口\n'), '\t')
  assert.deepEqual(parseCsv('位置\t中医名称\n合谷\t虎口'), [['位置', '中医名称'], ['合谷', '虎口']])
})

test('自动认分号', () => {
  assert.equal(detectDelimiter('a;b\n1;2\n'), ';')
})

test('BOM 不落进首格', () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\n1,2'), [['a', 'b'], ['1', '2']])
})

test('GBK 解码', () => {
  // 「位置」的 GBK 字节：CE BB D6 C3
  const gbk = Uint8Array.from([0xce, 0xbb, 0xd6, 0xc3, 0x2c, 0x62])
  assert.equal(detectEncoding(gbk), 'gbk')
  assert.equal(decodeText(gbk), '位置,b')
})

test('UTF-16LE BOM', () => {
  const text = 'a,b\n1,2'
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  assert.equal(detectEncoding(bytes), 'utf-16le')
  assert.equal(decodeText(bytes), text)
})

test('序列化转义与往返', () => {
  const rows = [['位置', '备注'], ['合谷', '带,逗号'], ['足三里', '带"引号"'], ['太冲', '带\n换行']]
  const text = toCsv(rows)
  assert.match(text, /"带,逗号"/)
  assert.match(text, /"带""引号"""/)
  assert.deepEqual(parseCsv(text), rows)
})

test('BOM 选项只影响输出', () => {
  assert.equal(toCsv([['a']], { bom: true }).startsWith('\uFEFF'), true)
  assert.equal(toCsv([['a']], { bom: false }).startsWith('\uFEFF'), false)
})

test('CRLF 默认行尾', () => {
  assert.equal(toCsv([['a'], ['b']]), 'a\r\nb\r\n')
})

test('首尾空格要加引号', () => {
  assert.equal(toCsv([[' pad ']]), '" pad "\r\n')
})

console.log(`csv.test.js: ${passed} passed`)
