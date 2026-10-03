import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, decodeJumpTarget } from "../src/assembler.js";

test("MOVI R1,-1 字值与小端字节", () => {
  const r = assemble("MOVI R1,-1");
  assert.equal(r.ok, true);
  assert.equal(r.binary!.readUInt32LE(0), 0x0110ffff);
  assert.deepEqual([...r.binary!], [0xff, 0xff, 0x10, 0x01]);
});

test("跳回本条 JMP 偏移为 -1", () => {
  const r = assemble("loop: JMP loop");
  assert.equal(r.ok, true);
  const d = decodeJumpTarget(r.binary!, 0);
  assert.equal(d.offset, -1);
  assert.equal(d.target, 0);
});

test("前向引用与后向引用", () => {
  const src = ["start: JMP end", "MOVI R1,1", "end: JMP start"].join("\n");
  const r = assemble(src);
  assert.equal(r.ok, true);
  const fwd = decodeJumpTarget(r.binary!, 0);
  assert.equal(fwd.target, 8);
  assert.equal(fwd.offset, 1);
  const back = decodeJumpTarget(r.binary!, 8);
  assert.equal(back.target, 0);
  assert.equal(back.offset, -3);
});

test("偏移为零（跳到下一条）", () => {
  const r = assemble("JMP next\nnext: HALT");
  assert.equal(r.ok, true);
  const d = decodeJumpTarget(r.binary!, 0);
  assert.equal(d.offset, 0);
  assert.equal(d.target, 4);
});

test("插入空行与注释不改变字节", () => {
  const a = assemble("MOVI R1,5\nloop: ADD R1,R2\nJMP loop");
  const b = assemble("; 注释\n\nMOVI R1,5\n\n; 又一注释\nloop: ADD R1,R2\n\nJMP loop\n");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.binary, b.binary);
});

test("多个标签指向同一项", () => {
  const r = assemble("a: b: c: HALT\nJMP b");
  assert.equal(r.ok, true);
  const names = r.symbols.map((s) => s.name).sort();
  assert.deepEqual(names, ["a", "b", "c"]);
  assert.ok(r.symbols.every((s) => s.address === 0));
});

test(".word 数据占位与小端输出", () => {
  const r = assemble(".word 0xDEADBEEF\n.word 4294967295\n.word 0");
  assert.equal(r.ok, true);
  assert.deepEqual([...r.binary!.subarray(0, 4)], [0xef, 0xbe, 0xad, 0xde]);
  assert.equal(r.binary!.readUInt32LE(4), 0xffffffff);
  assert.equal(r.binary!.readUInt32LE(8), 0);
});

test("MOVI 立即数边界", () => {
  assert.equal(assemble("MOVI R0,32767").ok, true);
  assert.equal(assemble("MOVI R0,-32768").ok, true);
  const over = assemble("MOVI R0,32768");
  assert.equal(over.ok, false);
  assert.equal(over.diagnostics[0].code, "E_IMM_RANGE");
  assert.equal(over.binary, null);
  assert.equal(assemble("MOVI R0,-32769").ok, false);
});

test(".word 越界与非法常量", () => {
  assert.equal(assemble(".word 4294967296").diagnostics[0].code, "E_WORD_RANGE");
  assert.equal(assemble(".word -1").diagnostics[0].code, "E_WORD_RANGE");
  assert.equal(assemble(".word 12x").diagnostics[0].code, "E_WORD_RANGE");
});

test("坏寄存器", () => {
  assert.equal(assemble("MOVI R16,1").diagnostics[0].code, "E_REG");
  assert.equal(assemble("ADD R1,RX").diagnostics[0].code, "E_REG");
  assert.equal(assemble("MOVI r1,1").diagnostics[0].code, "E_REG");
});

test("未知指令", () => {
  const r = assemble("FOO R1");
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, "E_UNKNOWN_OP");
});

test("重复定义与未定义标签", () => {
  assert.equal(assemble("a: HALT\na: HALT").diagnostics[0].code, "E_DUP_LABEL");
  assert.equal(assemble("JMP nowhere").diagnostics[0].code, "E_UNDEF_LABEL");
});

test("跳到数据项或文件末端被拒绝", () => {
  assert.equal(assemble("JMP d\nd: .word 1").diagnostics[0].code, "E_JUMP_TARGET");
  assert.equal(assemble("JMP tail\nHALT\ntail:").diagnostics[0].code, "E_JUMP_TARGET");
});

test("操作元个数校验", () => {
  assert.equal(assemble("HALT R1").diagnostics[0].code, "E_OPERAND_COUNT");
  assert.equal(assemble("MOVI R1").diagnostics[0].code, "E_OPERAND_COUNT");
  assert.equal(assemble("JMP a, b").diagnostics[0].code, "E_OPERAND_COUNT");
});

test("JZ 编码与标签区分大小写", () => {
  const r = assemble("JZ R3, done\ndone: HALT");
  assert.equal(r.ok, true);
  const d = decodeJumpTarget(r.binary!, 0);
  assert.equal(d.opcode, 4);
  assert.equal(d.rd, 3);
  assert.equal(d.offset, 0);
  assert.equal(assemble("JMP Done\ndone: HALT").diagnostics[0].code, "E_UNDEF_LABEL");
});

test("清单独立解码核对跳转目标", () => {
  const src = ["top: MOVI R1,10", "JZ R0, top", "JMP top"].join("\n");
  const r = assemble(src);
  assert.equal(r.ok, true);
  for (const e of r.listing) {
    if (e.address === null || !e.note.includes("offset=")) continue;
    const d = decodeJumpTarget(r.binary!, e.address);
    const m = /next=0x([0-9a-f]+) target=0x([0-9a-f]+) offset=(-?\d+)/.exec(e.note)!;
    assert.equal(d.next, parseInt(m[1], 16));
    assert.equal(d.target, parseInt(m[2], 16));
    assert.equal(d.offset, Number(m[3]));
  }
});

test("失败时不产生二进制", () => {
  const r = assemble("MOVI R1,1\nJMP missing");
  assert.equal(r.ok, false);
  assert.equal(r.binary, null);
  assert.ok(r.diagnostics.length > 0);
});
