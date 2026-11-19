/**
 * 随包分发的 fortune-sheet 必须能在「真宿主那份 CSP」下跑。
 *
 * 编辑器页由宿主带 `Content-Security-Policy: script-src 'self'`（**没有**
 * `'unsafe-eval'`）发出。fortune 1.0.4 原来的「插入行」实现用
 * `new Function("d", "return d.splice(...)")` 现场拼函数——在真机上被 CSP 拒掉：
 *
 *   - 右键「向下插入行」→ onClick 里抛 EvalError → 看着就是「点了没反应」；
 *   - HTML 粘贴在表尾需要补行时 → `Im()` 在 React 的 updater 里抛错 →
 *     React 18 把整棵树卸掉 → 画布白屏。
 *
 * 所以本地补丁把三处 `new Function` 换成等价的 `JSON.parse` + `unshift/splice`。
 * 这个测试守两件事：包里不许再出现 eval / new Function；补丁后的调用还在。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundle = readFileSync(fileURLToPath(new URL('../assets/fortune.js', import.meta.url)), 'utf8')

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

test('fortune.js 里没有 new Function（CSP 下会被拒）', () => {
  assert.equal(bundle.includes('new Function('), false, '插入行补丁被覆盖了？new Function 会撞 script-src \'self\'')
})

test('fortune.js 里没有 eval( / Function( 这类动态执行', () => {
  const directEval = /(^|[^.\w$])eval\s*\(/.test(bundle)
  assert.equal(directEval, false, '发现直接 eval() 调用，CSP 会拒绝')
  assert.equal(/\bFunction\s*=\s*Function\b/.test(bundle), false)
})

test('插入行的补丁还在：unshift/splice 走 apply + JSON.parse', () => {
  assert.ok(bundle.includes('m.unshift.apply(m,Xt.map(function(x){return JSON.parse(x)}))'), '向上插入到首行的补丁丢了')
  assert.ok(bundle.includes('m.splice.apply(m,[l,0].concat(Xt.map(function(x){return JSON.parse(x)})))'), '向上插入到中间的补丁丢了')
  assert.ok(bundle.includes('m.splice.apply(m,[l+1,0].concat(Xt.map(function(x){return JSON.parse(x)})))'), '向下插入的补丁丢了')
})

test('编辑器页的 CSP 保持严格（shipping host 侧配置没被放宽）', () => {
  const host = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')
  assert.ok(host.includes("\"script-src 'self'\""), 'index.js 的 EDITOR_CSP 应保持 script-src \'self\'')
  assert.equal(host.includes("'unsafe-eval'"), false, '不要为了跑通组件而给编辑器页开 unsafe-eval')
})

console.log(`fortune.csp.test.js: ${passed} passed`)
process.exit(0)
