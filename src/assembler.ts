export const ISA_VERSION = "isa-1.0";
export const MAX_LINES = 10000;
export const MAX_BYTES = 65536;

export interface Diagnostic {
  line: number;
  code: string;
  message: string;
}

export interface SymbolEntry {
  name: string;
  address: number;
  kind: "code" | "data" | "end";
}

export interface ListingEntry {
  line: number;
  address: number | null;
  bytes: string;
  source: string;
  note: string;
}

export interface AssembleResult {
  ok: boolean;
  binary: Buffer | null;
  symbols: SymbolEntry[];
  listing: ListingEntry[];
  diagnostics: Diagnostic[];
}

const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REG_RE = /^R(1[0-5]|[0-9])$/;

const OPCODES: Record<string, number> = {
  HALT: 0x00,
  MOVI: 0x01,
  ADD: 0x02,
  JMP: 0x03,
  JZ: 0x04,
};

interface Item {
  line: number;
  address: number;
  kind: "instr" | "data";
  op: string;
  args: string[];
  source: string;
}

function fail(line: number, code: string, message: string): Diagnostic {
  return { line, code, message };
}

export function assemble(source: string): AssembleResult {
  const diagnostics: Diagnostic[] = [];
  const symbols: SymbolEntry[] = [];
  const listing: ListingEntry[] = [];
  const lines = source.split(/\r?\n/);

  if (lines.length > MAX_LINES) {
    diagnostics.push(fail(MAX_LINES + 1, "E_LIMIT", `源行数超过上限 ${MAX_LINES}`));
    return { ok: false, binary: null, symbols, listing, diagnostics };
  }

  // ---------- Pass 1: addresses, labels, item kinds ----------
  const items: Item[] = [];
  const labelMap = new Map<string, SymbolEntry>();
  let address = 0;
  let pass1Error = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    let text = raw;
    const semi = text.indexOf(";");
    if (semi >= 0) text = text.slice(0, semi);
    text = text.trim();

    // collect leading labels (multiple allowed)
    let rest = text;
    for (;;) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/.exec(rest);
      if (!m) break;
      const name = m[1];
      if (labelMap.has(name)) {
        diagnostics.push(fail(lineNo, "E_DUP_LABEL", `标签重复定义: ${name}`));
        pass1Error = true;
      } else {
        const entry: SymbolEntry = { name, address, kind: "code" };
        labelMap.set(name, entry);
        symbols.push(entry);
      }
      rest = rest.slice(m[0].length).trim();
    }
    if (rest.includes(":")) {
      diagnostics.push(fail(lineNo, "E_SYNTAX", `非法标签语法: ${rest}`));
      pass1Error = true;
      continue;
    }
    if (rest === "") {
      listing.push({ line: lineNo, address: null, bytes: "", source: raw, note: "" });
      continue;
    }

    if (address + 4 > MAX_BYTES) {
      diagnostics.push(fail(lineNo, "E_LIMIT", `输出字节数超过上限 ${MAX_BYTES}`));
      pass1Error = true;
      break;
    }

    const sp = rest.indexOf(" ");
    const head = sp < 0 ? rest : rest.slice(0, sp);
    const argText = sp < 0 ? "" : rest.slice(sp + 1).trim();
    const args = argText === "" ? [] : argText.split(",").map((a) => a.trim());

    if (head === ".word") {
      items.push({ line: lineNo, address, kind: "data", op: ".word", args, source: raw });
    } else if (Object.prototype.hasOwnProperty.call(OPCODES, head)) {
      items.push({ line: lineNo, address, kind: "instr", op: head, args, source: raw });
    } else {
      diagnostics.push(fail(lineNo, "E_UNKNOWN_OP", `未知指令或伪指令: ${head}`));
      pass1Error = true;
      continue;
    }
    address += 4;
  }

  // mark label kinds: data if the item at its address is data, end if past last item
  const itemAt = new Map<number, Item>();
  for (const it of items) itemAt.set(it.address, it);
  for (const sym of symbols) {
    const it = itemAt.get(sym.address);
    if (!it) sym.kind = "end";
    else sym.kind = it.kind === "data" ? "data" : "code";
  }

  if (pass1Error) {
    return { ok: false, binary: null, symbols, listing, diagnostics };
  }

  // ---------- Pass 2: encode ----------
  const buffers: Buffer[] = [];
  let pass2Error = false;

  const emitWord = (word: number): string => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(word >>> 0, 0);
    buffers.push(b);
    return b.toString("hex").replace(/(..)/g, "$1 ").trim().toUpperCase();
  };

  const checkReg = (line: number, tok: string): number | null => {
    if (!REG_RE.test(tok)) {
      diagnostics.push(fail(line, "E_REG", `非法寄存器: ${tok}（应为 R0-R15）`));
      pass2Error = true;
      return null;
    }
    return parseInt(tok.slice(1), 10);
  };

  const resolveJumpTarget = (line: number, name: string, curAddr: number): { word: number; note: string } | null => {
    if (!LABEL_RE.test(name)) {
      diagnostics.push(fail(line, "E_SYNTAX", `非法标签引用: ${name}`));
      pass2Error = true;
      return null;
    }
    const sym = labelMap.get(name);
    if (!sym) {
      diagnostics.push(fail(line, "E_UNDEF_LABEL", `未定义标签: ${name}`));
      pass2Error = true;
      return null;
    }
    if (sym.kind === "data") {
      diagnostics.push(fail(line, "E_JUMP_TARGET", `跳转目标 ${name} 指向数据项，已拒绝`));
      pass2Error = true;
      return null;
    }
    if (sym.kind === "end") {
      diagnostics.push(fail(line, "E_JUMP_TARGET", `跳转目标 ${name} 位于文件末端，已拒绝`));
      pass2Error = true;
      return null;
    }
    const next = curAddr + 4;
    const delta = sym.address - next;
    const offset = delta / 4;
    if (!Number.isInteger(offset) || offset < -32768 || offset > 32767) {
      diagnostics.push(fail(line, "E_JUMP_RANGE", `跳转偏移 ${offset} 超出有符号十六位范围`));
      pass2Error = true;
      return null;
    }
    const note = `next=0x${next.toString(16).padStart(4, "0")} target=0x${sym.address.toString(16).padStart(4, "0")} offset=${offset}`;
    return { word: offset & 0xffff, note };
  };

  for (const it of items) {
    let word = 0;
    let note = "";
    const opc = OPCODES[it.op] ?? 0;

    if (it.op === ".word") {
      if (it.args.length !== 1) {
        diagnostics.push(fail(it.line, "E_OPERAND_COUNT", `.word 需要 1 个操作数，得到 ${it.args.length}`));
        pass2Error = true;
        continue;
      }
      const t = it.args[0];
      let v: bigint;
      if (/^0x[0-9a-fA-F]+$/.test(t)) v = BigInt(t);
      else if (/^[0-9]+$/.test(t)) v = BigInt(t);
      else {
        diagnostics.push(fail(it.line, "E_WORD_RANGE", `.word 常量非法: ${t}`));
        pass2Error = true;
        continue;
      }
      if (v < 0n || v > 0xffffffffn) {
        diagnostics.push(fail(it.line, "E_WORD_RANGE", `.word 常量超出 0..4294967295: ${t}`));
        pass2Error = true;
        continue;
      }
      word = Number(v);
      note = `data=${word} (0x${(word >>> 0).toString(16).padStart(8, "0")})`;
    } else if (it.op === "HALT") {
      if (it.args.length !== 0) {
        diagnostics.push(fail(it.line, "E_OPERAND_COUNT", `HALT 不需要操作数`));
        pass2Error = true;
        continue;
      }
      word = 0;
      note = "halt";
    } else if (it.op === "MOVI") {
      if (it.args.length !== 2) {
        diagnostics.push(fail(it.line, "E_OPERAND_COUNT", `MOVI 需要 2 个操作数，得到 ${it.args.length}`));
        pass2Error = true;
        continue;
      }
      const rd = checkReg(it.line, it.args[0]);
      if (rd === null) continue;
      if (!/^-?[0-9]+$/.test(it.args[1])) {
        diagnostics.push(fail(it.line, "E_IMM_RANGE", `MOVI 立即数须为带可选负号的十进制: ${it.args[1]}`));
        pass2Error = true;
        continue;
      }
      const imm = parseInt(it.args[1], 10);
      if (imm < -32768 || imm > 32767) {
        diagnostics.push(fail(it.line, "E_IMM_RANGE", `MOVI 立即数 ${imm} 超出 -32768..32767`));
        pass2Error = true;
        continue;
      }
      word = (opc << 24) | (rd << 20) | (imm & 0xffff);
      note = `MOVI R${rd}, ${imm}`;
    } else if (it.op === "ADD") {
      if (it.args.length !== 2) {
        diagnostics.push(fail(it.line, "E_OPERAND_COUNT", `ADD 需要 2 个操作数，得到 ${it.args.length}`));
        pass2Error = true;
        continue;
      }
      const rd = checkReg(it.line, it.args[0]);
      const rs = checkReg(it.line, it.args[1]);
      if (rd === null || rs === null) continue;
      word = (opc << 24) | (rd << 20) | (rs << 16);
      note = `ADD R${rd}, R${rs}`;
    } else if (it.op === "JMP" || it.op === "JZ") {
      const need = it.op === "JMP" ? 1 : 2;
      if (it.args.length !== need) {
        diagnostics.push(fail(it.line, "E_OPERAND_COUNT", `${it.op} 需要 ${need} 个操作数，得到 ${it.args.length}`));
        pass2Error = true;
        continue;
      }
      let rd = 0;
      let labelName: string;
      if (it.op === "JZ") {
        const r = checkReg(it.line, it.args[0]);
        if (r === null) continue;
        rd = r;
        labelName = it.args[1];
      } else {
        labelName = it.args[0];
      }
      const res = resolveJumpTarget(it.line, labelName, it.address);
      if (!res) continue;
      word = (opc << 24) | (rd << 20) | res.word;
      note = `${it.op} -> ${labelName}: ${res.note}`;
    }

    const hex = emitWord(word);
    listing.push({ line: it.line, address: it.address, bytes: hex, source: it.source, note });
  }

  if (pass2Error) {
    return { ok: false, binary: null, symbols, listing, diagnostics };
  }
  return { ok: true, binary: Buffer.concat(buffers), symbols, listing, diagnostics };
}

/** 独立解码：给定二进制与跳转指令地址，恢复目标地址用于核验 */
export function decodeJumpTarget(binary: Buffer, address: number): { opcode: number; rd: number; offset: number; next: number; target: number } {
  if (address % 4 !== 0 || address < 0 || address + 4 > binary.length) {
    throw new Error(`地址 ${address} 不是有效的指令地址`);
  }
  const word = binary.readUInt32LE(address);
  const opcode = (word >>> 24) & 0xff;
  if (opcode !== 0x03 && opcode !== 0x04) {
    throw new Error(`地址 ${address} 处不是跳转指令（操作码 0x${opcode.toString(16)}）`);
  }
  const rd = (word >>> 20) & 0xf;
  const imm = word & 0xffff;
  const offset = imm >= 0x8000 ? imm - 0x10000 : imm;
  const next = address + 4;
  return { opcode, rd, offset, next, target: next + offset * 4 };
}
