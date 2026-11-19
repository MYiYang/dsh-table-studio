/**
 * 编辑器页面的 DOM 冒烟测试（真 jspreadsheet 在 jsdom 里跑一遍）。
 *
 * jsdom 不是硬依赖：没装就跳过并退出 0，别把包测拖红。
 * 装了就把 editor.html 的骨架搭起来、把四份脚本按真实顺序注进去，
 * 再验三件事：网格画出来了、表头就是第一行、保存打的包对不对。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const assetDir = fileURLToPath(new URL('../assets/', import.meta.url))
const html = readFileSync(`${assetDir}editor.html`, 'utf8')

/**
 * jsdom 不是本包的依赖：装了就用，没装就跳过。
 * 指路办法：`DSH_JSDOM_PATH=<某个 node_modules 的绝对路径>` 再跑本文件。
 */
let JSDOM = null
try {
  const loader = createRequire(import.meta.url)
  const target = process.env.DSH_JSDOM_PATH && process.env.DSH_JSDOM_PATH.trim() !== ''
    ? process.env.DSH_JSDOM_PATH.trim()
    : 'jsdom'
  ;({ JSDOM } = loader(target))
} catch (error) {
  console.log(`editor.dom.test.js: 跳过（jsdom 不可用：${error?.message ?? error}）`)
  process.exit(0)
}

let passed = 0
/** @param {string} name - 用例名。 @param {() => void | Promise<void>} fn - 用例。 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    throw error
  }
}

const DOC = {
  ok: true,
  id: 'tbl_20261118_abc123',
  title: '穴位对照',
  columns: ['位置', '中医名称', '对应西医常见'],
  rows: [['合谷', '虎口', '头痛'], ['足三里', '下陵', '胃痛'], ['', '', '']],
  data: {
    columns: ['位置', '中医名称', '对应西医常见'],
    rows: [['合谷', '虎口', '头痛'], ['足三里', '下陵', '胃痛']],
  },
}

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:53224/dsh-table-studio/editor?doc=tbl_20261118_abc123&session=s1',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
})
const { window } = dom

/** 记下所有请求。 */
const requests = []
window.fetch = async (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
  const payload = String(url).includes('/session')
    ? { ok: true, id: DOC.id, doc: DOC }
    : DOC
  return { status: 200, json: async () => payload }
}
if (typeof window.ResizeObserver !== 'function') {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (typeof window.IntersectionObserver !== 'function') {
  window.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

/** 按真实顺序注入脚本（避开 jsdom 不发同源请求的限制）。 */
function inject(file) {
  const script = window.document.createElement('script')
  script.textContent = readFileSync(`${assetDir}${file}`, 'utf8')
  window.document.body.appendChild(script)
}

inject('jsuites.js')
inject('formula.js')
inject('jspreadsheet.js')
inject('editor.js')

/** 等一拍，让 boot() 的 fetch 链走完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

console.log('editor.dom.test.js')

await settle()

await test('载入文档后网格画出数据', () => {
  const cells = [...window.document.querySelectorAll('td[data-x]')].map((td) => td.textContent)
  assert.ok(cells.includes('合谷'), '应画出单元格内容')
  assert.ok(cells.includes('对应西医常见'), '表头行应画在第一行')
  assert.equal(window.document.querySelectorAll('tbody tr').length >= 2, true)
})

await test('snapshot 拆出 columns / rows 且不重复表头', () => {
  const snapshot = window.__tsEditor.snapshot()
  assert.equal(snapshot.id, DOC.id)
  assert.deepEqual([...snapshot.columns], DOC.columns)
  assert.equal(snapshot.rows.length, 2, '尾部整行空白应被裁掉')
  assert.deepEqual([...snapshot.rows[0]], ['合谷', '虎口', '头痛'])
})

await test('状态栏与角标更新', () => {
  const shape = window.document.getElementById('ts-shape').textContent
  assert.match(shape, /3 列 × 2 行/)
  assert.match(window.document.getElementById('ts-status').textContent, /已载入/)
  assert.equal(window.document.getElementById('ts-title').value, '穴位对照')
})

await test('CSV 文本带 BOM 与表头', () => {
  const text = window.__tsEditor.csvText()
  assert.equal(text.codePointAt(0), 0xfeff)
  assert.match(text, /位置,中医名称,对应西医常见\r\n/)
  assert.match(text, /合谷,虎口,头痛/)
})

await test('改标题后保存打出正确请求', async () => {
  const title = window.document.getElementById('ts-title')
  title.value = '改名后的表'
  title.dispatchEvent(new window.Event('input', { bubbles: true }))
  const ok = await window.__tsEditor.save()
  assert.equal(ok, true)
  const post = requests.filter((request) => request.method === 'POST').pop()
  assert.ok(post, '应发出 POST')
  assert.match(post.url, new RegExp(`/dsh-table-studio/api/doc/${DOC.id}$`))
  const body = JSON.parse(post.body)
  assert.equal(body.title, '改名后的表')
  assert.deepEqual([...body.columns], DOC.columns)
  assert.equal(body.rows.length, 2)
  assert.equal(body.sessionId, 's1')
})

await test('保存后状态栏转「已保存」', () => {
  assert.match(window.document.getElementById('ts-status').textContent, /已保存/)
})

await test('列宽按内容给：长文本那列更宽', () => {
  const widths = [...window.document.querySelectorAll('col')].map((col) => Number(col.getAttribute('width')))
  // 第 0 个是行号列（50），后面才是 A/B/C
  const dataWidths = widths.slice(1)
  assert.equal(dataWidths.length, 3)
  assert.ok(dataWidths[2] > dataWidths[0], `C 列(${dataWidths[2]}) 应比 A 列(${dataWidths[0]}) 宽`)
  assert.ok(dataWidths.every((width) => width >= 96 && width <= 320))
})

await test('主题消息会写进 CSS 变量（含 on-accent）', () => {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { __ts: 'theme', palette: { accent: '#112233', onAccent: '#ffeedd', bg: '#0a0a0a' } },
  }))
  const style = window.document.documentElement.style
  assert.equal(style.getPropertyValue('--ts-accent'), '#112233')
  assert.equal(style.getPropertyValue('--ts-on-accent'), '#ffeedd')
  assert.equal(style.getPropertyValue('--ts-bg'), '#0a0a0a')
})

await test('adopt 换一张表也画得出来', () => {
  window.__tsEditor.adopt({
    id: 'tbl_20261118_def456',
    title: '第二张',
    columns: ['甲', '乙'],
    rows: [['1', '2']],
    data: { columns: ['甲', '乙'], rows: [['1', '2']] },
  })
  const snapshot = window.__tsEditor.snapshot()
  assert.equal(snapshot.id, 'tbl_20261118_def456')
  assert.deepEqual([...snapshot.columns], ['甲', '乙'], '尾部备用列不该被当成真列')
  const cells = [...window.document.querySelectorAll('td[data-x]')].map((td) => td.textContent)
  assert.ok(cells.includes('甲'))
})

console.log(`editor.dom.test.js: ${passed} passed`)

// 编辑器页里有 4s 的轮询定时器：不显式退出，Node 进程会一直挂着。
// （别用 window.close()：jspreadsheet 仍在异步收尾，会打在已关闭的窗口上。）
process.exit(0)
