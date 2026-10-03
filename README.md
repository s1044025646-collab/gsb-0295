# 教学指令集双遍汇编后端

一个离线运行的教学用汇编服务：把单份汇编源文本汇编为小端二进制、符号表和逐行清单。
只做 API 与 CLI，不包含编程语言、宏、链接器、真实处理器执行或调试器。

- 运行时：Node.js（建议 >= 22.5，使用内置 `node:sqlite`，无原生依赖、无外部服务）
- 语言：TypeScript；存储：SQLite（项目内 `data/` 目录）；平台：Windows 本地

## 快速开始

```bat
npm install
npm run build        :: 编译 TypeScript 到 dist/
npm test             :: 编译并运行全部测试
npm start            :: 启动 API（默认端口 0 = 自动选择空闲端口）
npm run demo         :: 汇编 demo/loop.asm 并打印符号与清单
```

端口配置：`--port N` 参数或 `PORT` 环境变量；`0` 表示自动选空闲端口（默认）。
数据目录：`DATA_DIR` 环境变量，默认 `./data`（内含 `assembler.db`）。

## 指令集与编码规则（isa-1.0）

每条指令和每个 `.word` 都占 4 字节，地址从 0 开始，小端输出。
32 位字布局：最高 8 位操作码，随后两个 4 位寄存器字段，最低 16 位立即数。

| 指令 | 操作码 | 字段1 | 字段2 | 低16位 |
|---|---|---|---|---|
| `HALT` | 0x00 | 0 | 0 | 0 |
| `MOVI Rd,imm` | 0x01 | Rd | 0 | 有符号十六位立即数（十进制，可带负号，-32768..32767） |
| `ADD Rd,Rs` | 0x02 | Rd | Rs | 0 |
| `JMP label` | 0x03 | 0 | 0 | 有符号字偏移 |
| `JZ Rd,label` | 0x04 | Rd | 0 | 有符号字偏移 |
| `.word 常量` | — | — | — | 0..4294967295 的十进制或 0x 十六进制，原样小端输出 |

跳转偏移 = `(目标字节地址 - (当前地址 + 4)) / 4`，即相对下一条指令地址的有符号字偏移。
寄存器为 `R0`..`R15`。示例：`MOVI R1,-1` 编码为字 `0x0110FFFF`，小端字节 `FF FF 10 01`。

## 源文件语法

- 空行与以 `;` 开始的注释被忽略，且不影响后续字节地址。
- 标签：区分大小写的 ASCII 标识符（`[A-Za-z_][A-Za-z0-9_]*`）加冒号；一行可有多个标签指向同一项。
- 支持向前引用；重复定义、未定义标签、跳转到数据项或文件末端的标签会被明确拒绝。
- 上限：源 10000 行，输出 65536 字节。
- 所有越界（立即数、`.word`、跳转偏移）都会报错，绝不静默截断。

## 明确不支持的语法

宏与伪指令展开（除 `.word` 外的任何伪指令）、表达式与算术运算、字符/字符串常量、
十六进制立即数（仅 `.word` 支持 0x）、小写寄存器、段/节定义、链接与重定位、
指令执行与调试、变长指令。

## 两遍处理

1. 第一遍：逐行确定地址、收集标签、判定指令/数据类型（注释与空行不占地址）。
2. 第二遍：解析标签引用并编码；清单中每条跳转写出 `next`（下一条地址）、`target`（目标地址）与最终有符号 `offset`。

任何错误都不会产生可下载的部分二进制；失败诊断（含行号与错误码）会保存到数据库。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/assemble` | 提交 `{"source": "..."}`，汇编并保存；失败返回 422 与诊断 |
| GET | `/api/programs` | 历史列表（含 isa 版本、sha256、大小） |
| GET | `/api/programs/:id` | 源码、符号、诊断 |
| GET | `/api/programs/:id/symbols` | 符号表 |
| GET | `/api/programs/:id/listing` | 逐行清单 |
| GET | `/api/programs/:id/diagnostics` | 诊断 |
| GET | `/api/programs/:id/binary` | 下载二进制（失败程序返回 404） |
| GET | `/api/programs/:id/jumps/:addr` | 独立解码该地址的跳转字，返回 next/target/offset 供核验 |

错误码：`E_VALIDATION`、`E_BAD_JSON`、`E_NOT_FOUND`、`E_NO_ARTIFACT`、`E_NOT_JUMP`、`E_TOO_LARGE`，
汇编诊断码：`E_SYNTAX`、`E_UNKNOWN_OP`、`E_DUP_LABEL`、`E_UNDEF_LABEL`、`E_REG`、
`E_OPERAND_COUNT`、`E_IMM_RANGE`、`E_WORD_RANGE`、`E_JUMP_RANGE`、`E_JUMP_TARGET`、`E_LIMIT`。

## CLI

```bat
node dist/src/cli.js serve [--port N]     :: 启动 API
node dist/src/cli.js assemble <file.asm>  :: 汇编并保存，打印符号与清单
node dist/src/cli.js list                 :: 历史程序
node dist/src/cli.js show <id>            :: 源码/符号/诊断
node dist/src/cli.js export <id> <out>    :: 导出二进制
```

## 存储

SQLite 表：`programs`（源码、isa 版本、状态、sha256、大小、时间）、`symbols`、
`diagnostics`、`artifacts`（二进制 BLOB 与清单 JSON）。重启后可用相同 id 读取同一产物；
修改源码再次汇编会生成独立的新 id。

## 已知限制

- 单文件、单遍源码，无包含/宏机制；仅监听 `127.0.0.1`，无鉴权（本地教学用途）。
- Node 内置 `node:sqlite` 目前会打印实验性警告，不影响功能。
