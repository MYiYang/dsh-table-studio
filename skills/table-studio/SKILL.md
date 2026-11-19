---
name: table-studio
description: 所有表格展示的唯一通道（全局硬约束）：任何给用户看的结构化表格都必须用 table_render 出表格卡，禁止 Markdown 表格；含复制 / 下载 / 放大、右侧 Excel 风编辑器（工具条、公式栏、多工作表）与 table_read / table_update / table_export 往返链路。
whenToUse: 只要要展示表格就加载——查询结果、数据对比、清单、参数/证据/进度表、CSV/TSV 或 Excel 内容搬进 DSH；以及要导出 CSV、要在画布上改单元格时。
---

# 表格插件（dsh-table-studio）

## 硬约束（最高优先级）

**任何表格展示都必须走本插件**：凡是给用户看的结构化表格——查询结果、数据对比、清单、参数表、证据表、进度表等，只要有两列及以上、两行及以上，就必须调 `table_render` 出表格卡（要编辑时再 `table_open` 开右侧画布），**不要用 Markdown 表格（`| … |`）代替**。

理由：表格卡能复制、能下载 CSV、能放大、能二次编辑；Markdown 表格这些都没有。同一份数据既画卡片又写 Markdown 表属于重复展示，不要这么做。

只有两种例外：用户明确要求纯文字/不要卡片；或本轮 `table_*` 工具不可用——此时退化为文字或列表，并在回复里说明原因。

## When to use

- 用户要一张**表格**，且这张表之后可能要复制、导出、改单元格、被再次加工。
- 用户给了 CSV/TSV 或一段「位置/名称/说明」这类结构化数据，希望看着舒服、能带走。
- 用户说「打开表格」「在画布里改一下」「导出成 csv」。
- 回复里本来要写 Markdown 表格时——换成 `table_render`。

## Steps

1. `table_render({ title, columns, rows, note?, source? })`
   - `columns` 是表头，`rows` 只放数据行（**不要把表头再写进 rows**）。
   - 也可以只给 `csv`（首行当表头），适合从文件/命令里抄来的数据。
   - 回执里带 `id`（`tbl_YYYYMMDD_xxxxxx`）与 `shape`（`3 列 × 12 行`）。
2. 要用户亲手改 → `table_open({ id })`：把这张表打开在右侧画布（本地 fortune-sheet 的 Excel 风编辑器：工具条、公式栏、行列表头、多工作表，可直接改单元格、拖填充柄、右键增删行列）。也可以 `table_open({ path })` 直接从工作区 CSV 起步。
3. 改完要接着加工 → `table_read({ id, format })` 读回：「csv」最省 token，「markdown」直接贴进回复，「json」要程序化处理。
4. 改内容 → `table_update({ id, columns, rows })` 整表覆盖（只想改一格也要给整行）。
5. 要文件 → `table_export({ id, path })`：写出 UTF-8 带 BOM 的 CSV（Excel/WPS 打开中文不乱码）；省略 `path` 时落到工作目录下的 `<标题>.csv`。

## Pitfalls

- **别把表头和数据混在一起**：`columns` 与 `rows` 分开写，否则表格卡会多出一行表头。
- **`table_update` 是整表覆盖**，不是打补丁：先 `table_read` 拿到全量，改完再整体写回。
- **不要自己拼 CSV 文本给用户**：`table_export` 会处理引号、逗号、换行与 BOM；手拼的 CSV 在字段带逗号时必坏。
- **大表要拆**：列 > 64、行 > 5000、单元格 > 60000 会被拒。宁可拆成多张表分别渲染。
- **用户说「下载」**：两个入口别混——卡片/画布上的「下载」按钮由 UI 直接存进系统默认下载目录（Desktop 不弹「另存为」），不需要模型插手；模型要给工作区落文件才用 `table_export` 并给路径。
- 表格的**唯一真相**在 `$DSH_HOME/table-studio/docs/<id>.json`；用户可能在画布上改过，所以二次加工前先 `table_read`，别信自己上一轮的记忆。

## Verification

- 回执里 `ok:true` 且有 `id` + `shape`；会话里出现标题栏为「表格」的卡片，右上三枚图标（复制 / 下载 / 放大）可点。
- 回复正文里**没有** `| … |` 形式的 Markdown 表格（硬约束的验收点）。
- 点放大：右侧画布出现同名 tab「表格」，先是 Excel 风工具条与公式栏，网格第一行是表头；改一格后状态栏出现「已保存」。
- 卡片「下载」：文件落进系统下载目录，浮出「下载完成 · 立即查看」；点「立即查看」右侧画布直接打开这张表。
- `table_export` 回执里的 `file` 路径存在，字节数 > 0；用 `read` 或 Excel 打开能看到中文表头。
- 拿不准表还在不在：`table_read({ id })`，报 `not-found` 就是 id 过期（例如插件重装清了文档目录）。
