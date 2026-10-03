import { test, } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/db";
import { createServer } from "../src/server";
import { AddressInfo } from "node:net";

async function withServer(
  fn: (base: string, store: Store) => Promise<void>
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asm-test-"));
  const store = new Store(path.join(dir, "test.db"));
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
    store.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
  }
}

const DEMO = "loop: MOVI R1, -1\nJZ R1, loop\nHALT\n.word 0xDEADBEEF";

test("API：提交、历史、详情、符号、清单、跳转查询、导出", async () => {
  await withServer(async (base) => {
    // 汇编
    const res = await fetch(`${base}/api/assemble`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: DEMO }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const id = body.id;

    // 历史
    const list = await (await fetch(`${base}/api/assemblies`)).json();
    assert.ok(list.assemblies.some((a: { id: number }) => a.id === id));

    // 详情
    const detail = await (await fetch(`${base}/api/assemblies/${id}`)).json();
    assert.equal(detail.status, "ok");
    assert.equal(detail.symbols.length, 1);
    assert.equal(detail.symbols[0].name, "loop");

    // 符号与清单子路由
    const syms = await (await fetch(`${base}/api/assemblies/${id}/symbols`)).json();
    assert.equal(syms.symbols[0].address, 0);
    const listing = await (await fetch(`${base}/api/assemblies/${id}/listing`)).json();
    assert.ok(listing.listing.some((l: { note: string }) => l.note.includes("偏移=-2")));

    // 跳转查询
    const jump = await (await fetch(`${base}/api/assemblies/${id}/jump?address=4`)).json();
    assert.equal(jump.jump.offset, -2);
    assert.equal(jump.jump.targetAddress, 0);
    const noJump = await fetch(`${base}/api/assemblies/${id}/jump?address=0`);
    assert.equal(noJump.status, 404);

    // 导出二进制
    const binRes = await fetch(`${base}/api/assemblies/${id}/binary`);
    assert.equal(binRes.status, 200);
    const buf = Buffer.from(await binRes.arrayBuffer());
    assert.equal(buf.length, 16);
    assert.equal(buf.readUInt32LE(0), 0x0110ffff);
  });
});

test("API：失败汇编返回 422 且无二进制可下载", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/assemble`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "JMP missing" }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.diagnostics[0].code, "E_UNDEF_LABEL");
    const binRes = await fetch(`${base}/api/assemblies/${body.id}/binary`);
    assert.equal(binRes.status, 409);
    const err = await binRes.json();
    assert.equal(err.error.code, "E_NO_ARTIFACT");
  });
});

test("API：参数校验与错误码", async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/assemble`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: 42 }),
    });
    assert.equal((await bad.json()).error.code, "E_BAD_SOURCE");

    const badJson = await fetch(`${base}/api/assemble`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assert.equal((await badJson.json()).error.code, "E_BAD_JSON");

    const notFound = await fetch(`${base}/api/assemblies/9999`);
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).error.code, "E_NOT_FOUND");

    const okRes = await fetch(`${base}/api/assemble`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "HALT" }),
    });
    const okId = (await okRes.json()).id;
    const badAddr = await fetch(`${base}/api/assemblies/${okId}/jump?address=abc`);
    assert.equal((await badAddr.json()).error.code, "E_BAD_ADDRESS");
  });
});

test("持久化：重启（重开数据库）后可读取同一产物", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asm-persist-"));
  try {
    const dbPath = path.join(dir, "test.db");
    const s1 = new Store(dbPath);
    const { assemble } = await import("../src/assembler");
    const r = assemble(DEMO);
    const id = s1.saveAssembly(DEMO, r);
    s1.close();

    const s2 = new Store(dbPath);
    const row = s2.getAssembly(id);
    assert.equal(row!.status, "ok");
    assert.deepEqual(s2.getBinary(id), r.binary);
    assert.equal(s2.getJumps(id)[0].offset, -2);
    s2.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放 */ }
  }
});
