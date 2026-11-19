# 第三方许可

本包随附以下 MIT 许可的第三方代码。原件许可文本一并收录在下文，分发时请保留。

## fortune-sheet 1.0.4（@fortune-sheet/react + @fortune-sheet/core + @fortune-sheet/formula-parser）

- 文件：`assets/fortune.js`、`assets/fortune.css`（用 esbuild 打成 IIFE，React 18 一并打进去）
- 来源：https://github.com/ruilisi/fortune-sheet
- 许可：MIT
- 本地补丁：`assets/fortune.js` 里一处一行修改——初次挂载的默认选区由 `row:[0], column:[0]` 改为 `row:[0,0], column:[0,0]`。上游 bug 会让公式栏名称框显示 `A1:NaN`；只改这一个字面量，不涉及其它行为。

## React 18.3.1 / ReactDOM 18.3.1

- 文件：已打进 `assets/fortune.js`
- 来源：https://github.com/facebook/react
- 许可：MIT

## jspreadsheet CE 5.0.4

- 文件：`assets/jspreadsheet.js`、`assets/jspreadsheet.css`
- 来源：https://github.com/jspreadsheet/ce
- 许可：MIT

```
MIT License

Copyright (c) 2024 Jspreadsheet Ltd

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## jSuites 5.12.0

- 文件：`assets/jsuites.js`、`assets/jsuites.css`
- 来源：https://github.com/jsuites/jsuites
- 许可：MIT（版权行 Copyright (c) Jspreadsheet，文本同上）

## @jspreadsheet/formula 2.0.2

- 文件：`assets/formula.js`
- 来源：https://github.com/jspreadsheet/formula
- 许可：MIT（文件头已注明 "This is a free software MIT"，文本同上）
