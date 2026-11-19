# dsh-table-studio

DeepSeek Harness 的**表格插件**：会话里出一张表格卡（复制 / 下载 / 放大），点放大进右侧画布，画布里是本地绑定的 [fortune-sheet](https://github.com/ruilisi/fortune-sheet) **Excel 风编辑器**——工具条、公式栏、行列表头、工作表标签、公式引擎全都在，库随包分发，**没有任何 CDN 依赖**。

下载不再弹系统「另存为」：点一下就直接存进默认下载目录，完成后浮一个「下载完成 · 立即查看」，点「立即查看」直接在右侧表格编辑器里打开这张表。

## 怎么看到它（三个入口）

1. **回复末尾**：模型调过 `table_render` / `table_open` 的那一轮，正文之后会出现卡片（轮末直显）；
2. **工具调用行内**：同上那次调用所在的位置；若轮末已画过，这里只留一行「表格「X」已渲染在下方」；
3. **右侧画布的「+」菜单**：右侧栏顶部的加号 → 「表格」，不必经过卡片；打开后显示本会话当前那张表。

> 换了新版本要 `Ctrl+R` 强刷一次：客户端 bundle 是页面加载时取走的，不刷新就一直跑旧包。

## 它长什么样

会话里（对应参考图的第一种）：

```
┌────────────────────────────────────────────┐
│ 表格  [标题]                    [⧉] [⤓] [⤢] │  ← 复制 / 下载 CSV / 放大
├──────────┬────────────┬────────────────────┤
│ 位置     │ 中医名称   │ 对应西医常见       │
├──────────┼────────────┼────────────────────┤
│ 合谷     │ 虎口       │ 头痛               │
└──────────┴────────────┴────────────────────┘
  3 列 × 1 行 · 口径说明…
```

卡片右上三枚键的语义：

- **复制**：整表以制表符分隔进剪贴板，可直接粘进 Excel/WPS；
- **下载**：直接存进**系统默认下载目录**（Desktop 下走 DSH 的 `fileActions`，不再弹「另存为」对话框；重复文件名自动加 ` (1)`），完成后浮一条「下载完成 · 立即查看」；
- **放大**：打开只读大图预览——只看不进编辑。

「下载完成」提示里的**立即查看**直接在右侧表格编辑器（Excel 风）里打开这张表，不再绕一层预览弹层；提示里同时给出实际落盘的绝对路径。预览里的底栏另有备注、`下载 CSV`、`在画布里编辑` 三个去处。表不再自动把画布拽出来——官人要的是先看清楚，而不是被拉进编辑器。

这张卡片出现两处，且同一张表只画一次：

1. **回复末尾**（轮末直显）：正文之后、动作行之前，靠 `conversation.chat.turnTail` + 会话事件投影重建——刷新、回放、冷启动都能重画；
2. **工具调用行里**：同一次 `table_render` 的卡片；若轮末已经画过，这里退成一行「表格「X」已渲染在下方」，免得两张表并排。

放大后（右侧画布）就是一张 Excel：**工具条**（撤销/重做、格式刷、字体字号、加粗斜体下划线、字色填充、边框、合并、对齐、数字格式、冻结、筛选、排序、条件格式、公式、查找替换…）+ **公式栏**（左边名称框显示 `A1`，右边 `fx` 内容）+ **行列表头** + **底部工作表标签**（`+` 新建、右键重命名/复制/删除/调色/隐藏/移动）+ 右下角缩放与统计。纸面固定白纸黑字，深色主题只染顶栏与状态栏，不反相表格。**插入 / 删除行列**：单元格右键（向上/向下插入行、向左/向右插入列）或行列头上右键（删除/隐藏/行高列宽），与 Excel 一致；表格的**表头永远认得出来**——在表头上方插了空行、或在 A 列左边插了空列，保存时按「第一条有内容的行/列」定位表头并自动归位，不会把「列1、列2…」写进表头。**冻结窗格、筛选、列宽行高、图片、条件格式**都随文档保存，重开原样还原；右键菜单里的「向下插入行 / 向右插入列」等项，点中间那个数量框也算点整行（fortune 原本在输入框上吞掉点击，看着像插入没反应）；**插到表格末尾的空行 / 空列也会保留**——角标会标「尾部 1 行空白」并随文档落盘，往里面打字后自动转成正文行（原先只保留网格尺寸、不写进数据，看起来就像插入没生效）。单元格可直接编辑、拖填充柄、右键增删行列；**多张工作表与格式（加粗、字色、列宽、合并、条件格式…）都会随文档保存**，重开原样还原。改动 1.2 秒去抖自动保存，`Ctrl+S` 立刻保存；工具条「下载」按钮与卡片下载同一套逻辑（静默存默认目录）。

## 装

```bash
dsh plugin --profile <profile> add link:/abs/path/to/dsh-table-studio
```

或在本机用插件管理面板把 `include:dsh-table-studio` 打开。装完刷新页面：工具列表里会多出 `table_render` / `table_open` / `table_read` / `table_update` / `table_export`，自带 skill `table-studio` 也会出现在技能目录里。

## 工具

| 工具 | 干什么 | 关键参数 |
| --- | --- | --- |
| `table_render` | 建表并渲染会话卡片 | `title`、`columns`、`rows`，或直接给 `csv` |
| `table_open` | 在右侧画布打开编辑器 | `id` / `path`（工作区 CSV）/ `columns`+`rows` |
| `table_read` | 读回内容（用户可能改过） | `id`、`format` = `csv` \| `markdown` \| `json` |
| `table_update` | 整表覆盖写回 | `id`、`columns`、`rows`（或 `csv`） |
| `table_export` | 导出 CSV 到工作区 | `id`、`path`（省略则 `<标题>.csv`） |

回执里带 `id`（`tbl_YYYYMMDD_xxxxxx`）与 `shape`（`3 列 × 12 行`）；失败返回 `{ok:false, code, message}`，不抛异常。

## 路由与数据

| 路由 | 用途 |
| --- | --- |
| `GET  /dsh-table-studio/editor?doc=&session=` | 编辑器整页（自带 CSP） |
| `GET  /dsh-table-studio/assets/*` | 白名单静态资源：fortune / jspreadsheet / jSuites / formula / editor |
| `GET  /dsh-table-studio/api/health` | 自检：文档目录、文档数 |
| `GET  /dsh-table-studio/api/session?sessionId=` | 本会话当前表 |
| `GET  /dsh-table-studio/api/doc/:id` | 取表（`data.columns` + `data.rows`，编辑器另读 `sheets` 格式附件） |
| `POST /dsh-table-studio/api/doc/:id` | 存表（编辑器调用；`sheets` 三态：数组=替换、`null`=清掉、省略=不动） |
| `GET  /dsh-table-studio/api/doc/:id/csv` | 下载 CSV（UTF-8 带 BOM） |
| `POST /dsh-table-studio/api/import` | 从工作区 CSV 文件导入 |
| `POST /dsh-table-studio/api/create` | 新建空表 |

文档落在 `$DSH_HOME/table-studio/docs/<id>.json`（人可读、可备份），`sessions.json` 记「哪个会话在看哪张表」。不往工作区写东西，免得污染用户的仓库。

## 结构

```
index.js              host：工具 + 路由 + 自带 skill 注册
client.js             会话卡片 + 右侧画布（React，无构建步骤）
lib/csv.js            CSV 编解码：引号/换行/CRLF/GBK/BOM/分隔符探测
lib/model.js          表格模型：归一化、限额、Markdown / CSV 序列化
lib/store.js          落盘：原子写、会话索引、导入导出
lib/skill.js          自带 skill 的注册器（provider 方式，卸载即带走）
assets/editor.html    编辑器页（脚本：fortune → jSuites → formula → jspreadsheet → editor）
assets/editor.js      编辑器胶水：载入 / Excel 风网格 / 多表与格式 / 自动保存 / 跟随模型改动 / 复制 / 下载 / 主题
assets/editor.css     编辑器样式（全走 --ts-* 变量，由宿主令牌喂；纸面固定白纸）
assets/fortune.*      本地绑定的 Excel 风表格组件 + 其 CSS（MIT，含一处本地小补丁）
assets/jspreadsheet.* 兜底组件（MIT）
assets/jsuites.*      jspreadsheet 的依赖（MIT）
assets/formula.js     公式扩展（MIT）
skills/table-studio/  自带 skill：告诉模型什么时候该用这套工具
test/                 145 项单测 + jsdom 冒烟（缺 jsdom 时自动跳过）
```

## 全局约束：表格展示一律走本插件

插件在 host 半侧把一条硬约束注册进 DSH 的系统提示（`ctx.systemPrompt.section`，段名 `dsh-table-studio:table-policy`，order 3200）：

> 凡是给用户看的结构化表格——查询结果、数据对比、清单、参数表、证据表、进度表等，只要有两列及以上、两行及以上，就必须用 `table_render` 出表格卡，不要用 Markdown 表格（`| … |`）代替；要编辑时再 `table_open` 开右侧画布。

它**随插件注册/卸载**，不写进用户记忆、不改全局配置；配置项 `policy: false` 可单独关掉（自带 skill 仍保留）。自带 skill `table-studio` 的 description 与正文也领同一道约束——系统提示负责「每一步都看见」，skill 负责「具体怎么做」。

```yaml
# profile 的 cordis.patch.yml 里可覆盖（默认都开）
- id: dsh-table-studio
  config:
    skill: true   # 注册自带 skill
    policy: true  # 注册全局表格约束
```

## 表格组件

画布里的网格有两套，都随包分发、都不走 CDN：

| 组件 | 体积 | 长相 | 地位 |
| --- | --- | --- | --- |
| fortune-sheet 1.0.4 | 3.7MB + 52KB CSS | 完整 Excel 风：工具条、公式栏、名称框、行列表头、工作表标签、公式/格式/多表 | **默认** |
| jspreadsheet CE 5.0.4 | 860KB | 轻量网格（无工具条/公式栏/多表） | 兜底 |

编辑器不再自己造「+ 行 / + 列 / 组件 / 外观」那排小按钮，也隐藏了 fortune 在网格底部浮出的「添加 N 行（在底部添加）/ 回到顶部」控制条：增删行列跟 Excel 一样直接在单元格/行列头右键（插入行、插入列）里做，顶栏只留文档名与 复制 / 下载 / 保存。纸面**永远白纸**（Excel 就是白纸黑字），深色主题只染顶栏与状态栏；不再把 canvas 反相成「深色纸」——那正是此前被官人判「没眼看」的那版。若 fortune 某次量不到容器尺寸（canvas 高为 0），1.8 秒后自动重建网格（重建三次仍不行才退回 jspreadsheet），绝不留一块白板。

### 为什么插入行以前「点了没反应」、粘贴还白屏（0.5.8 已修）

两个症状是**同一个病根**：编辑器页在真宿主里带 `Content-Security-Policy: script-src 'self'`（没有
`'unsafe-eval'`），而 fortune 1.0.4 的「插入行」实现是拿 `new Function("d", "return d.splice(...)")`
现场拼函数执行的——被 CSP 一拒，后果分两种：

| 触发方式 | 组件内部发生了什么 | 用户看到 |
| --- | --- | --- |
| 右键「向上 / 向下插入行」 | 菜单项 `onClick` 里抛 `EvalError` | 菜单还开着，**行没多**（=「无法增加行」） |
| 从 Excel / 网页 / 本表格复制一块粘到表尾（HTML 带 `<tr>`，需要补行） | 粘贴处理里的 `Im()` 在 **React 的 state updater** 里抛错 | React 18 把整棵树卸掉 → **白屏** |

之所以以前自测都「通过」，是因为测试台没带那份 CSP；带上 CSP 一跑，`EvalError: ... 'unsafe-eval' is not
an allowed source of script` 立刻现形。

**修法（不放开 CSP）**：给随包的 `assets/fortune.js` 打第二处本地补丁，把三处 `new Function` 换成等价的
`JSON.parse` + `unshift/splice`：

```js
// 原：new Function("d","return d.splice(" + l + ",0," + Xt.join(",") + ")")(m)
m.splice.apply(m, [l, 0].concat(Xt.map(function (x) { return JSON.parse(x) })))
```

`test/fortune.csp.test.js` 守着这条线：包里出现 `new Function(` / `eval(` 就红，谁把 vendor 换成新构建都会
被拦住。另外编辑器自己也接管了插入菜单项（见下），这样「向上/向下」与 Excel 一致，不再差一行。

### 头部被挡、按钮字挤成一团（0.5.9 已修）

**1）表格头部（工具条 / 列头）被顶栏遮住。** 编辑器的 `renderFortune` 早期拿「容器高 − 画布高」去加高
宿主，本意是别在底部留白；可画布本来就该比容器矮（上面还有工具条 41px、公式栏 34px、底部工作表标签），
于是每挂一次就多长出上百像素——宿主比容器高，超出的那截被 `overflow: hidden` 的容器裁掉，顶部那一层
（工具条、列头）就钻到文档名那条深色顶栏底下，看着像「头被挡住」、列头点不着。

现在：宿主高度只钉成**容器的实际高度**、不再累加；`#ts-sheet / .ts-fortune / .fortune-container` 三只
裁切容器的 `scrollTop/scrollLeft` 用滚动监听按住（真正的滚动交给 fortune 自己的画布区）；顶栏补
`position: relative; z-index: 5`，任何浮层都不许盖它；标题输入框补 `text-overflow: ellipsis`
（原来长标题被硬切成半个字）。

**2）放大预览页脚按钮的字被挤在一起。** 按钮定了 26px 高却没有 `white-space: nowrap`，页脚又是 flex，
说明文字 `flex: 1 1 auto` 一抢空间，按钮就被压到比文字还窄：`下载 CSV` 折成「下载 / CSV」、`在画布里编辑`
折成三行并被定高裁掉半截。而且整块弹层是 `position: fixed` 画在卡片里的，撞上 DSH 带 transform / overflow
的祖先会被框住、裁成一条窄缝。

现在：`.tst-pbtn` 补 `flex: 0 0 auto; white-space: nowrap`，页脚允许换行，说明文字改成 `flex: 1 1 120px`
让位，弹层加 `max-width: 100%`，并且用 `react-dom` 的 `createPortal` 挂到 `document.body`（拿不到
react-dom 就退回原画法，不拿一个浮层赌整个客户端半侧）。

### 白屏与「插不进去」的兜底（0.5.7 起）

| 症状 | 兜底 |
| --- | --- |
| 渲染抛错 → React 卸树 → 白板 | error boundary 换成「重建网格」面版，自动重挂两次；崩溃写 `note-*.json` |
| 网格 DOM 凭空消失 | 看门狗（1s）连续两次发现没有画布 → 从上一份好数据重建 |
| 粘贴 / 插入时组件内部抛错 | `onChange` 整段 try/catch（异常穿回 React 就是白屏）；粘贴前把空选区补回 A1 |
| 右键「插入行/列」点了没反应 | 编辑器**接管**插入菜单项：按 1 基下标自己调 `insertRowOrColumn`（与 Excel 一致），再关掉菜单；失败才退回「两拍核对指纹」 |
| 组件里 `new Function` 撞 CSP | 已给 vendor 打补丁去掉（见上一节），并由 `test/fortune.csp.test.js` 守线 |
| 脏数据把 `r/c` 写成几十万 | 数据面铺矩阵时按宿主限额（64 列 / 5000 行）截断，避免几百万个字符串把页面卡死 |

## 几个取舍

- **为什么最后是 fortune-sheet**：官人要「像 Excel/WPS 那样的表格编辑器」。fortune-sheet（MIT）自带工具条、公式栏、名称框、行列表头、工作表标签、公式引擎与多表，观感最接近；代价是要用 esbuild 打成一个 IIFE（React 一并打进去，3.7MB），还得处理 canvas 量尺寸的脾气，并提供一处「初次选区 `row:[0]` → `row:[0,0]`」的本地补丁（否则名称框会显示 `A1:NaN`）。jspreadsheet CE 更轻、CSS 可控，留作兜底。
- **为什么编辑器在 iframe 里**：fortune 与 jspreadsheet 都自带一套全局 CSS，直接注入 DSH 主文档会污染其它界面；iframe 还顺手把它和宿主的 React 树隔离开，崩了不影响会话。
- **为什么卡片不用组件库画**：卡片只有一张表，几行 CSS 就能和 DSH 的排版对齐（12px 正文、6px 圆角、`--dsw-alias-*` 令牌）；引一个网格库反而会跟宿主样式打架。
- **CSV 一定带 BOM**：中文 Windows 上 Excel/WPS 只认 UTF-8 BOM，不带就把「位置」读成乱码。
- **读取时敢猜编码**：导入的 CSV 先看 BOM，再试严格 UTF-8，最后退 GBK——`Excel → 另存为 CSV` 在中文系统上默认就是 GBK。

## 测试

```bash
npm test                                        # 145 项 + 真 DOM 冒烟 10 项（jsdom 缺失时后者自动跳过）
DSH_JSDOM_PATH=/path/to/node_modules/jsdom node test/editor.dom.test.js
```

覆盖：CSV 编解码与往返、模型归一化与限额、存储原子写与 GBK 导入、`sheets` 格式附件三态、全局表格约束（系统提示段注入与降级）、host 工具与路由（含 403/404/405 分支）、client 卡片取数三路兜底与槽注册、静默下载（`fileActions.save(...,'download')`、取消/失败/兜底、路径回显）、编辑器逻辑（多表还原、`data→celldata` 格式保留、表头定位与插入行列偏移归位、冻结/筛选等附件还原、CSV、白纸主题）、编辑器页在真 jspreadsheet 上的载入/编辑/保存。

## 自报状态（没有屏幕时怎么验）

客户端在四个时刻向 host 报一声，host 合并写进 `$DSH_HOME/table-studio/client.json`：

| kind | 含义 |
| --- | --- |
| `apply` | 页面加载了这个版本的 bundle（`version` 字段就是版本号） |
| `card` | 会话里的表格卡真的画出来了（带 `id` 与行数） |
| `tail` | 轮末那张表画出来了（带 `callIds`） |
| `open-tab` | 放大/自动开画布走到哪一步（`openTab-mine` / `storage-skip` / `no-sidebarRight` …） |
| `panel-mount` / `panel-iframe` | 右栏画布挂载、iframe 地址 |
| `editor-page` / `editor` / `editor-error` | iframe 里的编辑器页跑起来了、取到数据并画出网格、或失败原因 |
| `editor-crash` | 编辑器里的一次事故（渲染崩、白板、粘贴前空选区…）；完整堆栈与「白屏前几步」在 `note-*.json` |
| `file-download` | 一次下载落到哪（Desktop 给绝对路径，失败给原因） |

`events` 是最近 80 条的流水，`last` 是每种一条的最新值。验收时不必盯着屏幕，看这个文件就能知道卡在哪一环。

## 排错

- **看不到卡片**：先 `Ctrl+R` 强刷（客户端 bundle 换了要重新加载）。仍看不到就查 `$DSH_HOME/table-studio/note-*.json`——卡片渲染抛错会被错误边界接住、投给 `/dsh-table-studio/api/note` 落盘，文件里 `message` / `stack` 就是原因。
- **确认槽位真挂上了**：`cordis_inspect_query`（client / Slots）查 `root: "conversation.chat.turnTail"` 与 `"tool.call.toolview"` 的 occupants，应有 `dsh-table-studio` / `table_render`。
- **换了随包组件却像没换**：`assets/fortune.js|css`、`jspreadsheet.*`、`jsuites.*`、`formula.js` 都按 `immutable` 长缓存发出去，URL 上带 `?v=YYYYMMDD`。替换这些文件后必须把 `assets/editor.html` 里的 `?v=` 改一位，否则浏览器还在用旧副本（0.5.8 的 CSP 修的就是这个 bundle，`?v=20261120`）。
- **确认页面跑的是哪一版**：客户端启动时会 `POST /dsh-table-studio/api/boot`，把 `{version, at, ua}` 写成 `$DSH_HOME/table-studio/client.json`——文件里的 `version` 就是当前页面的包版本，`at` 是最后一次刷新的时刻。没有这个文件＝页面还没加载到新包。
- **确认路由活着**：`curl -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/dsh-table-studio/api/health` → `403` 就是对（无凭据必拒），`404` 才是没挂上。
- **画布空白**：`/dsh-table-studio/editor` 的 CSP 只放同源脚本；若把 assets 挪了位置，`script-src 'self'` 照样放行，但要保证 `editor.html` 里的路径与实际路由一致。
- **编辑器白屏 / 网格没了**（0.5.7 起会自愈）：fortune 是 React 树，渲染里抛一次错整棵树就被卸掉，以前只剩一块白。现在三层兜底：
  1. `error boundary` 接住渲染错误，换成「重建网格 / 只保留纯值」面版，并自动重挂前两次；
  2. 看门狗每秒看一眼，网格连续两次不见（画布 DOM 没了）就从上一份好数据重建；
  3. 任何未捕获异常 / 未处理的 rejection 都记进 `$DSH_HOME/table-studio/note-*.json`，带着 `message`、`stack`、以及最近 30 步操作（`breadcrumbs`：copy / paste / insert / save / heal / render…）。
  下次再白屏，**先看 `note-*.json` 里最后一条 `kind`**，那就是病根；没有 note 文件说明页面根本没跑到脚本（查 CSP / 路由）。
- **右键「插入行 / 插入列」没反应**：菜单项里的数量输入框会吞点击（它自己的 `onClick` 里 `stopPropagation`），而且菜单项的 `onClick` 还依赖组件内部 DOM ref。0.5.7 起点完两拍核对画布指纹——没插进去就用 Workbook 暴露的 `insertRowOrColumn` 按输入框里的数字自己插一次，并在状态栏回一句「已插入 N 行 · 现在 X 列 × Y 行」（插在尾部空白区时画面本来就看不出来，得靠这句确认）。

## 限制

- 单表上限：64 列 / 5000 行 / 60000 单元格，超了会拒绝并让你拆表。
- 只处理 CSV/TSV；`.xlsx` 请先另存为 CSV（或走 office 插件转）。
- 编辑器只在前台画布工作，没有多人协同；撤销/重做在会话内可用，但不随文档持久化。
- `table_read` / `table_update` / `table_export` 只认**第一张工作表**（模型侧的数据面）；多表与格式存在文档的 `sheets` 附件里，只给编辑器还原用。
- 格式附件上限 4MB（编辑器侧）/ 8MB（host 侧），超了自动退回「只存值」，不会把文档写爆。
- 表格不进会话上下文：模型要看内容得调 `table_read`。

## 许可

MIT（本插件）。第三方：jspreadsheet CE 5.0.4 / jSuites 5.12.0 / @jspreadsheet/formula 2.0.2，均 MIT，见 [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md)。
