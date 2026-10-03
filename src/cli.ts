import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./db.js";
import { assemble } from "./assembler.js";
import { startServer } from "./server.js";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

function usage(): never {
  console.log(`用法:
  node dist/src/cli.js serve [--port N]        启动 API 服务（默认端口 0 = 自动选空闲端口）
  node dist/src/cli.js assemble <file.asm>     汇编文件并保存，输出符号与清单
  node dist/src/cli.js list                    列出历史程序
  node dist/src/cli.js show <id>               查看源码、符号与诊断
  node dist/src/cli.js export <id> <out.bin>   导出二进制
环境变量: PORT（默认端口）, DATA_DIR（数据目录，默认 ./data）`);
  process.exit(1);
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  const store = new Store(DATA_DIR);

  if (cmd === "serve") {
    let port = process.env.PORT ? Number(process.env.PORT) : 0;
    const pi = args.indexOf("--port");
    if (pi >= 0) port = Number(args[pi + 1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error("端口必须是 0-65535 的整数（0 表示自动选择空闲端口）");
      process.exit(1);
    }
    const { port: actual } = await startServer(store, port);
    console.log(`API 服务已启动: http://127.0.0.1:${actual}/api/programs`);
    return;
  }

  if (cmd === "assemble") {
    const file = args[0];
    if (!file) usage();
    const source = fs.readFileSync(file, "utf8");
    const result = assemble(source);
    const id = store.saveProgram(source, result);
    console.log(`程序 id=${id} 状态=${result.ok ? "ok" : "failed"}`);
    for (const s of result.symbols) console.log(`  符号 ${s.name} = 0x${s.address.toString(16).padStart(4, "0")} (${s.kind})`);
    for (const e of result.listing) {
      const addr = e.address === null ? "      " : "0x" + e.address.toString(16).padStart(4, "0");
      console.log(`  L${String(e.line).padStart(3)} ${addr}  ${e.bytes.padEnd(11)} ${e.source.trim()}${e.note ? "   ; " + e.note : ""}`);
    }
    for (const d of result.diagnostics) console.error(`  错误 L${d.line} [${d.code}] ${d.message}`);
    process.exit(result.ok ? 0 : 2);
  }

  if (cmd === "list") {
    for (const p of store.listPrograms()) {
      console.log(`id=${p.id} ${p.status} isa=${p.isa_version} size=${p.size ?? "-"} sha256=${p.sha256 ?? "-"} ${p.created_at}`);
    }
    return;
  }

  if (cmd === "show") {
    const id = Number(args[0]);
    const p = store.getProgram(id);
    if (!p) { console.error(`程序 ${id} 不存在`); process.exit(1); }
    console.log(`id=${p.id} status=${p.status} isa=${p.isa_version} sha256=${p.sha256 ?? "-"}`);
    console.log("--- 源码 ---"); console.log(p.source);
    console.log("--- 符号 ---");
    for (const s of store.getSymbols(id) as any[]) console.log(`  ${s.name} = 0x${s.address.toString(16).padStart(4, "0")} (${s.kind})`);
    console.log("--- 诊断 ---");
    for (const d of store.getDiagnostics(id) as any[]) console.log(`  L${d.line} [${d.code}] ${d.message}`);
    return;
  }

  if (cmd === "export") {
    const id = Number(args[0]);
    const out = args[1];
    if (!out) usage();
    const art = store.getArtifact(id);
    if (!art) { console.error(`程序 ${id} 无可导出二进制（不存在或汇编失败）`); process.exit(1); }
    fs.writeFileSync(out, art.binary);
    console.log(`已导出 ${art.binary.length} 字节到 ${out}`);
    return;
  }

  usage();
}

main().catch((e) => { console.error(e); process.exit(1); });
