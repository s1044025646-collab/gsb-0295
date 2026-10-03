import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, decodeJumpTarget } from "../src/assembler";

function wordAt(binary: Buffer, addr: number): number {
  return binary.readUInt32LE(addr);
}

test("MOVI R1,-1 字值为 0x0110FFFF，小端字节 FF FF 10 01", () => {
  const r = assemble("MOVI R1,-1");
  assert.equal(r.ok, true);
  assert.equal(wordAt(r.binary!, 0), 0x0110ffff);
  assert.deepEqual([...r.binary!], [0xff, 0xff, 0x10, 0x01]);
  assert.equal(r.binary!.length, 4);
});

test("HALT 全零，ADD 使用两个寄存器字段", () => {
  const r = assemble("HALT\nADD R2, R3");
  assert.equal(r.ok, true);
  assert.equal(wordAt(r.binary!, 0), 0x00000000);
  assert.equal(wordAt(r.binary!, 4), 0x02230000);
});

test("跳回本条 JMP 的偏移为 -1", () => {
  const r = assemble("loop: JMP loop");
  assert.equal(r.ok, true);
  const j = r.jumps[0];
  assert.equal(j.offset, -1);
  assert.equal(j.nextAddress, 4);
  assert.equal(j.targetAddress, 0);
  assert.equal(wordAt(r.binary!, 0) & 0xffff, 0xffff);
});

test("前向引用与偏移零", () => {
  const r = assemble("JMP next\nnext: HALT");
  assert.equal(r.ok, true);
  assert.equal(r.jumps[0].offset, 0);
  assert.equal(wordAt(r.binary!, 0), 0x03000000);
});

test("后向引用", () => {
  const src = "top: MOVI R0, 1\nADD R0, R0\nJZ R0, top";
  const r = assemble(src);
  assert.equal(r.ok, true);
  const j = r.jumps[0];
  assert.equal(j.address, 8);
  assert.equal(j.targetAddress, 0);
  assert.equal(j.offset, -3); // (0 - 12) / 4
  assert.equal(wordAt(r.binary!, 8), 0x0400fffd);
});

test("插入空行与注释不改变字节", () => {
  const a = assemble("MOVI R1, 5\nloop: ADD R1, R1\nJZ R1, loop\nHALT");
  const b = assemble("; 头部注释\n\nMOVI R1, 5 ; 行尾注释\n\nloop: ADD R1, R1\n\nJZ R1, loop\n\nHALT\n; 尾部");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(b.binary, a.binary);
  assert.deepEqual(b.symbols, a.symbols);
});

test("连续多个标签指向同一项", () => {
  const r = assemble("a:\nb:\nc: HALT\nJMP a\nJMP b\nJMP c");
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.symbols.map((s) => [s.name, s.address]),
    [["a", 0], ["b", 0], ["c", 0]]
  );
  assert.ok(r.jumps.every((j) => j.targetAddress === 0));
});

test(".word 数据占位与大小端", () => {
  const r = assemble(".word 0xDEADBEEF\n.word 42\n.word 0\n.word 4294967295");
  assert.equal(r.ok, true);
  assert.deepEqual([...r.binary!.subarray(0, 4)], [0xef, 0xbe, 0xad, 0xde]);
  assert.equal(wordAt(r.binary!, 4), 42);
  assert.equal(wordAt(r.binary!, 12), 0xffffffff);
});

test(".word 越界与非法常量被拒绝", () => {
  assert.equal(assemble(".word 4294967296").diagnostics[0].code, "E_WORD_RANGE");
  assert.equal(assemble(".word -1").diagnostics[0].code, "E_BAD_WORD");
  assert.equal(assemble(".word 0x100000000").diagnostics[0].code, "E_WORD_RANGE");
  assert.equal(assemble(".word 1 2").diagnostics[0].code, "E_OPERAND_COUNT");
});

test("MOVI 立即数范围边界与越界", () => {
  assert.equal(assemble("MOVI R0, 32767").ok, true);
  assert.equal(assemble("MOVI R0, -32768").ok, true);
  assert.equal(assemble("MOVI R0, 32768").diagnostics[0].code, "E_IMM_RANGE");
  assert.equal(assemble("MOVI R0, -32769").diagnostics[0].code, "E_IMM_RANGE");
  assert.equal(assemble("MOVI R0, 0x10").diagnostics[0].code, "E_BAD_IMM");
});

test("坏寄存器与未知指令", () => {
  assert.equal(assemble("MOVI R16, 1").diagnostics[0].code, "E_BAD_REG");
  assert.equal(assemble("MOVI RX, 1").diagnostics[0].code, "E_BAD_REG");
  assert.equal(assemble("ADD R1").diagnostics[0].code, "E_OPERAND_COUNT");
  assert.equal(assemble("MUL R1, R2").diagnostics[0].code, "E_UNKNOWN_MNEMONIC");
});

test("重复定义、未定义标签", () => {
  assert.equal(assemble("x: HALT\nx: HALT").diagnostics[0].code, "E_DUP_LABEL");
  assert.equal(assemble("JMP nowhere").diagnostics[0].code, "E_UNDEF_LABEL");
});

test("跳到数据项或文件末端被拒绝", () => {
  assert.equal(assemble("JMP d\nd: .word 1").diagnostics[0].code, "E_JUMP_TO_DATA");
  assert.equal(assemble("JMP end\nHALT\nend:").diagnostics[0].code, "E_JUMP_EOF");
});

test("失败时不产出二进制", () => {
  const r = assemble("MOVI R1, -1\nJMP missing");
  assert.equal(r.ok, false);
  assert.equal(r.binary, null);
  assert.ok(r.diagnostics.length > 0);
});

test("跳转范围越界（>32767 字）", () => {
  const filler = "HALT\n".repeat(32768);
  const r = assemble("JMP far\n" + filler + "far: HALT");
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, "E_JUMP_RANGE");
});

test("清单独立解码跳转字恢复目标地址", () => {
  const src = [
    "start: MOVI R1, 10",   // 0
    "loop:  ADD R1, R1",    // 4
    "       JZ R1, done",   // 8
    "       JMP loop",      // 12
    "done:  HALT",          // 16
    "       .word 0x1234",  // 20
  ].join("\n");
  const r = assemble(src);
  assert.equal(r.ok, true);
  for (const j of r.jumps) {
    const word = wordAt(r.binary!, j.address);
    const decoded = decodeJumpTarget(word, j.address);
    assert.equal(decoded.targetAddress, j.targetAddress,
      `地址 ${j.address} 处跳转解码目标应与符号表一致`);
    assert.equal(decoded.offset, j.offset);
  }
  // 清单中的跳转解释包含下一条地址、目标地址与偏移
  const jumpLines = r.listing.filter((l) => l.note.includes("下一条地址"));
  assert.equal(jumpLines.length, 2);
  assert.match(jumpLines[0].note, /下一条地址=0x000C 目标=done@0x0010 偏移=1/);
  assert.match(jumpLines[1].note, /下一条地址=0x0010 目标=loop@0x0004 偏移=-3/);
});

test("标签区分大小写", () => {
  assert.equal(assemble("JMP Loop\nloop: HALT").diagnostics[0].code, "E_UNDEF_LABEL");
});

test("行数上限", () => {
  const big = "HALT\n".repeat(65537);
  assert.equal(assemble(big).diagnostics[0].code, "E_TOO_LARGE");
});
