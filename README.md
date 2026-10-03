# 教学指令集双遍汇编后端（edu-asm）

一个 Windows 本地可运行的离线汇编服务：把单份汇编源文本变成小端二进制、符号表和逐行清单。
仅提供 **API 与 CLI**，不含编程语言、宏、链接器、真实处理器执行或调试器。

- 运行时：Node.js（建议 ≥ 22，使用内置 `node:sqlite`，零原生依赖、零运行时第三方包）
- 语言：TypeScript（仅开发期需要 `typescript` 与 `@types/node`）
- 存储：SQLite，数据目录为项目内 `data/`（`data/assemblies.db`）
- 不依赖 Docker、WSL、付费服务或任何外部在线 API

## 快速开始

```bat
npm install        :: 安装开发依赖（typescript）
npm run build      :: 编译到 dist/
npm test           :: 构建并运行全部测试（node:test）
npm start          :: 启动 API 服务（默认自动选择空闲端口）
npm run demo       :: 汇编 demo/loop.asm 并导出 demo/loop.bin
```

端口配置：环境变量 `PORT`，或命令行 `--port=8080`；不传或传 0 时由系统分配空闲端口，
启动后控制台会打印实际地址，如 `http://127.0.0.1:49744`。

## CLI

```bat
node dist/cli.js assemble <file.asm> [--out=file.bin] [--serve[=port]]
node dist/cli.js list                 :: 历史记录
node dist/cli.js show <id>            :: 查看符号表与清单
node dist/cli.js export <id> <out.bin>:: 导出二进制
node dist/cli.js jump <id> <address>  :: 查询某条跳转的地址解释
node dist/cli.js serve [--port=N]     :: 启动 API 服务
```

## HTTP API

所有错误返回 `{"error": {"code": "...", "message": "..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/assemble` | 提交源码并汇编，请求体 `{"source": "..."}`；失败返回 422 与诊断 |
| GET | `/api/assemblies` | 历史列表（id、状态、ISA 版本、大小、SHA-256、时间） |
| GET | `/api/assemblies/:id` | 详情：源码、符号表、诊断、清单、跳转 |
| GET | `/api/assemblies/:id/symbols` | 仅符号表 |
| GET | `/api/assemblies/:id/listing` | 仅逐行清单 |
| GET | `/api/assemblies/:id/jump?address=N` | 查询地址 N 处的跳转（下一条地址/目标/偏移） |
| GET | `/api/assemblies/:id/binary` | 下载二进制；失败记录返回 409 `E_NO_ARTIFACT` |

示例：

```bat
curl -X POST http://127.0.0.1:端口/api/assemble -H "Content-Type: application/json" -d "{\"source\":\"loop: JMP loop\"}"
curl http://127.0.0.1:端口/api/assemblies/1/binary -o out.bin
```

## 汇编语言规则

### 基本结构

- 每条指令与每个 `.word` 都占 **4 字节**，地址从 0 开始，按 4 递增。
- 空行与以 `;` 开始的注释（含行尾注释）被忽略，**不影响字节地址**。
- 标签：区分大小写的 ASCII 标识符（`[A-Za-z_][A-Za-z0-9_]*`）加冒号，如 `loop:`。
  连续多个标签可指向同一项；标签可独占一行（指向下一项）。
- 向前引用合法。重复定义（`E_DUP_LABEL`）、未定义标签（`E_UNDEF_LABEL`）、
  跳到数据项（`E_JUMP_TO_DATA`）或文件末端（`E_JUMP_EOF`）的标签均被拒绝。
- 上限：源文件 65536 行，输出 1 MiB（`E_TOO_LARGE`）。

### 指令编码（32 位字，小端输出）

| 位段 | 含义 |
| --- | --- |
| [31:24] | 操作码 |
| [23:20] | 寄存器字段 1 |
| [19:16] | 寄存器字段 2 |
| [15:0] | 立即数（补码） |

| 指令 | 操作码 | 字段 1 | 字段 2 | 低 16 位 |
| --- | --- | --- | --- | --- |
| `HALT` | 0x00 | 0 | 0 | 0 |
| `MOVI Rd, imm` | 0x01 | Rd | 0 | imm（-32768..32767，十进制，可带负号） |
| `ADD Rd, Rs` | 0x02 | Rd | Rs | 0 |
| `JMP label` | 0x03 | 0 | 0 | 有符号字偏移 |
| `JZ Rd, label` | 0x04 | Rd | 0 | 有符号字偏移 |

跳转偏移 = `(目标字节地址 - (当前地址 + 4)) / 4`，即相对**下一条指令**的有符号字偏移，
必须落在 -32768..32767（`E_JUMP_RANGE`）。

示例：`MOVI R1, -1` → 字 `0x0110FFFF` → 小端字节 `FF FF 10 01`；
`loop: JMP loop` → 偏移 `-1` → 字 `0x0300FFFF`。

### 数据伪指令

- `.word N`：N 为十进制或 `0x` 十六进制常量，范围 0..4294967295，按小端原样输出。

### 校验与错误码

寄存器必须为 `R0`..`R15`（`E_BAD_REG`）；操作元个数必须精确（`E_OPERAND_COUNT`）；
立即数与跳转范围严格校验（`E_IMM_RANGE` / `E_JUMP_RANGE`），**不做静默截断**。
任何错误都不会发布可下载的部分二进制（产物表仅在成功时写入），
失败诊断（含源行号与错误码）会保存到数据库供查询。

完整错误码：`E_TOO_LARGE`、`E_DUP_LABEL`、`E_UNDEF_LABEL`、`E_UNKNOWN_MNEMONIC`、
`E_OPERAND_COUNT`、`E_BAD_REG`、`E_BAD_IMM`、`E_IMM_RANGE`、`E_BAD_WORD`、`E_WORD_RANGE`、
`E_BAD_LABEL`、`E_JUMP_TO_DATA`、`E_JUMP_EOF`、`E_JUMP_RANGE`（汇编期）；
`E_BAD_JSON`、`E_BAD_SOURCE`、`E_BAD_ID`、`E_BAD_ADDRESS`、`E_NOT_FOUND`、`E_NO_JUMP`、
`E_NO_ARTIFACT`、`E_BODY_TOO_LARGE`、`E_ROUTE`、`E_INTERNAL`（API 层）。

### 明确不支持的语法

- 宏、条件汇编、`include`、表达式求值（如 `label+4`）
- 除 `.word` 外的伪指令（无 `.byte`/`.ascii`/`.org`/`.equ` 等）
- 字符/字符串常量、浮点常量
- 寄存器别名（`sp`/`lr` 等）、小写寄存器以外的形式（`r1` 非法，须用 `R1`）
- 链接、重定位、多文件汇编、可执行文件格式输出
- 任何真实处理器的代码执行、仿真或调试

## 两遍处理与核验

1. **第一遍**：逐行确定字节地址、标签位置与指令/数据类型，建立符号表；
   地址只由指令/数据计数决定，注释与空行不影响偏移，也绝不使用源行号代替字节地址。
2. **第二遍**：解析标签引用并编码，生成小端二进制与逐行清单。
   清单中每条跳转都写明：下一条地址、目标地址、最终有符号偏移。

测试中用 `decodeJumpTarget` 从二进制独立解码跳转字（符号扩展低 16 位，
`目标 = 当前地址 + 4 + 偏移 × 4`），与符号表交叉核对，覆盖：
`MOVI R1,-1` 编码、跳回本条 `JMP` 偏移 -1、前向/后向引用、偏移零、
插入空行不改字节、多个标签同址、数据占位、范围边界与越界、坏寄存器、未知指令等。

## 持久化

SQLite（`data/assemblies.db`）保存：源码、指令集版本（`edu-asm/1.0`）、符号表、
诊断、逐行清单、跳转解释与产物摘要（大小、SHA-256、二进制 BLOB）。
重启后可读取同一产物；每次提交都生成独立的新记录（新 id），修改源码即产生新版本。

## 项目结构

```
src/assembler.ts   双遍汇编器与跳转解码核验
src/db.ts          SQLite 持久化（node:sqlite）
src/server.ts      HTTP API（node:http）
src/cli.ts         命令行入口
tests/             node:test 测试（汇编器 + API + 持久化）
demo/loop.asm      演示源码（循环标签 + 数据）
```

## 限制

- 仅监听 `127.0.0.1`，无认证，面向本机教学用途。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 单文件、单指令集版本；无并发写入控制（SQLite 串行化已足够本机使用）。
