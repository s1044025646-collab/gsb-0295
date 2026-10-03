#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { assemble, AssembleResult } from "./assembler";
import { Store } from "./db";
import { startServer } from "./server";

function hex(n: number, w = 4): string {
  return "0x" + n.toString(16).toUpperCase().padStart(w, "0");
}

function printResult(result: AssembleResult) {
  if (result.diagnostics.length > 0) {
    console.log("诊断:");
    for (const d of result.diagnostics) {
      console.log(`  行 ${d.line} [${d.code}] ${d.message}`);
    }
  }
  if (result.symbols.length > 0) {
    console.log("符号表:");
    for (const s of result.symbols) {
      console.log(`  ${hex(s.address)}  ${s.name}  (${s.kind === "data" ? "数据" : "指令"})`);
    }
  }
  console.log("清单:");
  for (const l of result.listing) {
    const addr = l.address === null ? "      " : hex(l.address);
    const bytes = l.bytes
      ? l.bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")
      : "          ";
    const note = l.note ? `  ; ${l.note}` : "";
    console.log(`  ${String(l.line).padStart(4)}  ${addr}  ${bytes}  ${l.source.trim()}${note}`);
  }
  console.log(result.ok
    ? `汇编成功，输出 ${result.binary!.length} 字节。`
    : "汇编失败，未生成二进制产物。");
}

function usage(): never {
  console.error(`用法:
  node dist/src/cli.js assemble <file.asm> [--out=file.bin] [--serve[=port]]
  node dist/src/cli.js list
  node dist/src/cli.js show <id>
  node dist/src/cli.js export <id> <out.bin>
  node dist/src/cli.js jump <id> <address>
  node dist/src/cli.js serve [--port=N]`);
  process.exit(2);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store();

  if (cmd === "assemble") {
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) usage();
    const source = fs.readFileSync(file, "utf8");
    const result = assemble(source);
    const id = store.saveAssembly(source, result);
    console.log(`已保存为记录 #${id}（ISA ${result.isaVersion}）`);
    printResult(result);
    const outArg = args.find((a) => a.startsWith("--out="));
    if (outArg && result.binary) {
      fs.writeFileSync(outArg.split("=")[1], result.binary);
      console.log(`二进制已写入 ${outArg.split("=")[1]}`);
    }
    const serveArg = args.find((a) => a === "--serve" || a.startsWith("--serve="));
    if (serveArg) {
      const port = serveArg.includes("=") ? parseInt(serveArg.split("=")[1], 10) : 0;
      const { port: actual } = await startServer(port);
      console.log(`演示服务已启动: http://127.0.0.1:${actual}/api/assemblies/${id}`);
      return; // 保持进程运行
    }
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === "list") {
    for (const r of store.listAssemblies()) {
      console.log(`#${r.id}  ${r.created_at}  ${r.status}  ISA=${r.isa_version}` +
        (r.size !== null ? `  ${r.size} 字节  sha256=${r.sha256!.slice(0, 12)}...` : ""));
    }
    return;
  }

  if (cmd === "show") {
    const id = parseInt(args[0] ?? "", 10);
    const row = store.getAssembly(id);
    if (!row) { console.error(`记录 #${args[0]} 不存在`); process.exit(1); }
    console.log(`#${row.id}  ${row.created_at}  ${row.status}  ISA=${row.isa_version}`);
    printResult({
      ok: row.status === "ok",
      isaVersion: row.isa_version,
      binary: store.getBinary(id),
      symbols: store.getSymbols(id),
      diagnostics: store.getDiagnostics(id),
      listing: store.getListing(id),
      jumps: store.getJumps(id),
    });
    return;
  }

  if (cmd === "export") {
    const id = parseInt(args[0] ?? "", 10);
    const out = args[1];
    if (!out) usage();
    const binary = store.getBinary(id);
    if (!binary) { console.error(`记录 #${args[0]} 没有可导出的二进制（失败或不存在）`); process.exit(1); }
    fs.writeFileSync(out, binary);
    console.log(`已导出 ${binary.length} 字节到 ${path.resolve(out)}`);
    return;
  }

  if (cmd === "jump") {
    const id = parseInt(args[0] ?? "", 10);
    const address = parseInt(args[1] ?? "", 10);
    if (Number.isNaN(id) || Number.isNaN(address)) usage();
    const jump = store.getJumpAt(id, address);
    if (!jump) { console.error(`记录 #${id} 在地址 ${address} 处没有跳转指令`); process.exit(1); }
    console.log(`地址 ${hex(jump.address)}: ${jump.mnemonic} ${jump.label}`);
    console.log(`  下一条地址=${hex(jump.nextAddress)} 目标地址=${hex(jump.targetAddress)} 偏移=${jump.offset}`);
    return;
  }

  if (cmd === "serve") {
    const portArg = args.find((a) => a.startsWith("--port="));
    const port = portArg ? parseInt(portArg.split("=")[1], 10) : 0;
    const { port: actual } = await startServer(Number.isNaN(port) ? 0 : port);
    console.log(`汇编服务已启动: http://127.0.0.1:${actual}`);
    return;
  }

  usage();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
