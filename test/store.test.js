/**
 * 存储单测：真写临时目录，不碰用户家目录。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, defaultRoot, DOC_VERSION } from '../lib/store.js'

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

const root = mkdtempSync(join(tmpdir(), 'table-studio-'))
const store = createStore({ root })

console.log('store.test.js')

test('defaultRoot 落在 DSH_HOME/table-studio', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:/tmp/fake-dsh'
  try {
    assert.equal(defaultRoot().replace(/\\/g, '/'), 'C:/tmp/fake-dsh/table-studio')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

/** 建一张样例表。 */
function sample(extra = {}) {
  return store.create({
    columns: ['位置', '中医名称', '对应西医常见'],
    rows: [['合谷', '虎口', '头痛'], ['足三里', '下陵', '胃痛']],
    title: '穴位对照',
    note: '示例',
    ...extra,
  })
}

test('create 落盘并能 read 回来', () => {
  const doc = sample()
  assert.match(doc.id, /^tbl_/)
  assert.equal(doc.version, DOC_VERSION)
  assert.ok(existsSync(join(root, 'docs', `${doc.id}.json`)))
  const back = store.read(doc.id)
  assert.deepEqual(back.columns, ['位置', '中医名称', '对应西医常见'])
  assert.equal(back.rows.length, 2)
})

test('read 拒绝穿越与不存在的 id', () => {
  assert.equal(store.read('../../etc/passwd'), null)
  assert.equal(store.read('tbl_19700101_000000'), null)
})

test('update 覆盖并刷新 updatedAt', () => {
  const doc = sample()
  const next = store.update(doc.id, { rows: [['合谷', '虎口', '头痛/牙痛']], title: '改过的标题' })
  assert.equal(next.title, '改过的标题')
  assert.equal(next.rows.length, 1)
  assert.equal(store.read(doc.id).rows.length, 1)
})

test('update 找不到时报 not-found', () => {
  try {
    store.update('tbl_19700101_000000', { rows: [] })
  } catch (error) {
    assert.equal(error.code, 'not-found')
    return
  }
  assert.fail('应该抛错')
})

test('list 按更新时间倒序且带摘要', () => {
  const a = sample({ title: 'A' })
  const b = sample({ title: 'B' })
  const list = store.list({ limit: 2 })
  assert.equal(list[0].id, b.id, '最新的在最前')
  assert.ok(list.some((item) => item.id === a.id))
  assert.equal(typeof list[0].columns, 'number')
})

test('会话当前表：设置后能取回', () => {
  const doc = sample()
  store.setCurrent('session-1', doc.id)
  assert.equal(store.current('session-1'), doc.id)
  assert.equal(store.current('session-2'), '')
})

test('importFile 读 GBK CSV', () => {
  const file = join(root, 'gbk.csv')
  // 「位置,名称\n合谷,虎口」的 GBK 字节
  const bytes = Buffer.from([
    0xce, 0xbb, 0xd6, 0xc3, 0x2c, 0xc3, 0xfb, 0xb3, 0xc6, 0x0a,
    0xba, 0xcf, 0xb9, 0xc8, 0x2c, 0xbb, 0xa2, 0xbf, 0xda,
  ])
  writeFileSync(file, bytes)
  const { doc, encoding } = store.importFile(file)
  assert.equal(encoding, 'gbk')
  assert.deepEqual(doc.columns, ['位置', '名称'])
  assert.deepEqual(doc.rows, [['合谷', '虎口']])
})

test('importFile 拒绝不存在的文件', () => {
  try {
    store.importFile(join(root, 'missing.csv'))
  } catch (error) {
    assert.equal(error.code, 'ENOENT')
    return
  }
  assert.fail('应该抛错')
})

test('exportFile 写 BOM + CRLF', () => {
  const doc = sample()
  const target = join(root, 'out', '穴位.csv')
  const written = store.exportFile(doc.id, target)
  assert.equal(written.file, target)
  const text = readFileSync(target, 'utf8')
  assert.equal(text.codePointAt(0), 0xfeff)
  assert.match(text, /位置,中医名称,对应西医常见\r\n/)
  assert.ok(written.bytes > 0)
})

test('exportFile 相对路径按 cwd 解析', () => {
  const doc = sample()
  const written = store.exportFile(doc.id, 'relative.csv', { cwd: root })
  assert.equal(written.file, join(root, 'relative.csv'))
  assert.ok(existsSync(written.file))
})

test('sheets 三态：写入 / 省略保留 / null 清掉', () => {
  const doc = sample()
  const sheets = [{
    name: '表格',
    celldata: [{ r: 0, c: 0, v: { v: '合谷', m: '合谷', bl: 1 } }],
    config: { columnlen: { 0: 120 } },
    order: 0,
    status: 1,
  }]
  const withSheets = store.update(doc.id, { sheets })
  assert.equal(Array.isArray(withSheets.sheets), true)
  assert.equal(withSheets.sheets[0].celldata[0].v.bl, 1)

  const kept = store.update(doc.id, { rows: [['合谷', '虎口', '头痛']] })
  assert.equal(Array.isArray(kept.sheets), true, '省略 sheets 时应保留原格式附件')

  const stored = JSON.parse(readFileSync(join(root, 'docs', `${doc.id}.json`), 'utf8'))
  assert.equal(stored.sheets[0].config.columnlen[0], 120, '落盘 JSON 里应能看到格式')

  const cleared = store.update(doc.id, { sheets: null })
  assert.equal(cleared.sheets, undefined)
  assert.equal(store.read(doc.id).sheets, undefined)
})

test('sheets 形状不对就不落盘', () => {
  const doc = sample()
  const bad = store.update(doc.id, { sheets: [{ name: '' }] })
  assert.equal(bad.sheets, undefined)
  const notArray = store.update(doc.id, { sheets: { name: 'x' } })
  assert.equal(notArray.sheets, undefined)
})

test('remove 删掉文件', () => {
  const doc = sample()
  assert.equal(store.remove(doc.id), true)
  assert.equal(store.read(doc.id), null)
  assert.equal(store.remove('bad id'), false)
})

test('坏 JSON 不会让 read 抛错', () => {
  const doc = sample()
  writeFileSync(join(root, 'docs', `${doc.id}.json`), '{ 坏掉')
  assert.equal(store.read(doc.id), null)
})

rmSync(root, { recursive: true, force: true })
console.log(`store.test.js: ${passed} passed`)
