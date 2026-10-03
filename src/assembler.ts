// 双遍汇编器：教学指令集
// 字编码（32 位，小端输出）：
//   [31:24] 操作码  [23:20] 寄存器字段1  [19:16] 寄存器字段2  [15:0] 立即数

export const ISA_VERSION = "edu-asm/1.0";
export const MAX_SOURCE_LINES = 65536;
export const MAX_OUTPUT_BYTES = 1 << 20; // 1 MiB

export interface Diagnostic {
  line: number; // 1 起始源行号
  code: string; // 错误码
  message: string;
}

export interface SymbolEntry {
  name: string;
  address: number;
  kind: "instruction" | "data";
}

export interface ListingEntry {
  line: number;
  source: string;
  address: number | null; // 该行对应的字节地址（无产物行为 null）
  bytes: number[] | null; // 小端编码字节
  note: string; // 符号解析 / 跳转解释说明
}

export interface JumpInfo {
  address: number;
  mnemonic: "JMP" | "JZ";
  label: string;
  nextAddress: number;
  targetAddress: number;
  offset: number; // 有符号字偏移
}

export interface AssembleResult {
  ok: boolean;
  isaVersion: string;
  binary: Buffer | null; // 失败时为 null，绝不发布部分二进制
  symbols: SymbolEntry[];
  diagnostics: Diagnostic[];
  listing: ListingEntry[];
  jumps: JumpInfo[];
}

const LABEL_RE = /^([A-Za-z_][A-Za-z0-9_]*):/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REG_RE = /^R(\d{1,2})$/;
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
  kind: "instruction" | "data";
  mnemonic: string;
  args: string[];
  labels: string[];
}

function err(diags: Diagnostic[], line: number, code: string, message: string) {
  diags.push({ line, code, message });
}

function parseRegister(tok: string): number | null {
  const m = REG_RE.exec(tok);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 0 && n <= 15 ? n : null;
}

function encodeWord(opcode: number, r1: number, r2: number, imm16: number): number {
  return (
    (((opcode & 0xff) << 24) |
      ((r1 & 0xf) << 20) |
      ((r2 & 0xf) << 16) |
      (imm16 & 0xffff)) >>>
    0
  );
}

function wordToBytesLE(word: number): number[] {
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}

function hex(n: number, width = 4): string {
  return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}

export function assemble(source: string): AssembleResult {
  const diagnostics: Diagnostic[] = [];
  const symbols: SymbolEntry[] = [];
  const listing: ListingEntry[] = [];
  const listingByLine = new Map<number, ListingEntry>();
  const jumps: JumpInfo[] = [];

  const lines = source.split(/\r\n|\r|\n/);
  if (lines.length > MAX_SOURCE_LINES) {
    err(diagnostics, MAX_SOURCE_LINES + 1, "E_TOO_LARGE",
      `源文件行数 ${lines.length} 超过上限 ${MAX_SOURCE_LINES}`);
    return fail(diagnostics, listing, symbols, jumps);
  }

  // ---------- 第一遍：确定每行地址、标签位置、指令/数据类型 ----------
  const items: Item[] = [];
  const labelMap = new Map<string, { address: number; kind: "instruction" | "data" }>();
  const itemByAddress = new Map<number, Item>();
  let pendingLabels: { name: string; line: number }[] = [];
  let address = 0;

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const noComment = rawLine.split(";", 1)[0];
    let rest = noComment.trim();
    const labels: string[] = [];

    // 连续多个标签可指向同一项
    for (;;) {
      const m = LABEL_RE.exec(rest);
      if (!m) break;
      labels.push(m[1]);
      rest = rest.slice(m[0].length).trim();
    }
    // 标签后若紧跟非法标识符字符（如 "foo:bar" 无冒号）会在下方作为未知指令报错

    if (rest === "") {
      // 纯标签行 / 空行 / 注释行：不占用地址，标签指向“下一项”的地址
      for (const name of labels) {
        if (labelMap.has(name)) {
          err(diagnostics, lineNo, "E_DUP_LABEL", `标签重复定义: ${name}`);
        } else {
          labelMap.set(name, { address, kind: "instruction" }); // kind 待定，见下方修正
        }
      }
      if (labels.length > 0) {
        // 暂存，待遇到实际项时修正 kind
        pendingLabels.push(...labels.map((n) => ({ name: n, line: lineNo })));
      }
      const empty: ListingEntry = { line: lineNo, source: rawLine, address: null, bytes: null, note: "" };
      listing.push(empty);
      listingByLine.set(lineNo, empty);
      return;
    }

    const tokens = rest.split(/[\s,]+/).filter((t) => t.length > 0);
    const mnemonic = tokens[0].toUpperCase();
    const args = tokens.slice(1);
    const isData = mnemonic === ".WORD";
    const kind: "instruction" | "data" = isData ? "data" : "instruction";

    // 之前纯标签行的标签先落在此项上，修正 kind（保持源码顺序）
    for (const p of pendingLabels) {
      const e = labelMap.get(p.name);
      if (e && e.address === address) {
        e.kind = kind;
        symbols.push({ name: p.name, address, kind });
      }
    }
    pendingLabels = [];
    // 本行标签落在此项上
    for (const name of labels) {
      if (labelMap.has(name)) {
        err(diagnostics, lineNo, "E_DUP_LABEL", `标签重复定义: ${name}`);
      } else {
        labelMap.set(name, { address, kind });
        symbols.push({ name, address, kind });
      }
    }

    if (!isData && !(mnemonic in OPCODES)) {
      err(diagnostics, lineNo, "E_UNKNOWN_MNEMONIC", `未知指令或伪指令: ${tokens[0]}`);
    }
    if (address + 4 > MAX_OUTPUT_BYTES) {
      err(diagnostics, lineNo, "E_TOO_LARGE",
        `输出字节数超过上限 ${MAX_OUTPUT_BYTES}`);
    }

    const item: Item = { line: lineNo, address, kind, mnemonic, args, labels };
    items.push(item);
    itemByAddress.set(address, item);
    const itemEntry: ListingEntry = { line: lineNo, source: rawLine, address, bytes: null, note: "" };
    listing.push(itemEntry);
    listingByLine.set(lineNo, itemEntry);
    address += 4;
  });

  // 文件末尾的悬空标签：指向文件末端，作为跳转目标非法
  for (const p of pendingLabels) {
    symbols.push({ name: p.name, address, kind: "data" }); // 标记为非指令
    const e = labelMap.get(p.name);
    if (e) e.kind = "data";
  }
  const endAddress = address;

  // ---------- 第二遍：解析引用并编码 ----------
  const bytes: number[] = [];
  for (const item of items) {
    const { line, address: addr, mnemonic, args } = item;
    let word: number | null = null;
    let note = "";

    if (item.kind === "data") {
      if (args.length !== 1) {
        err(diagnostics, line, "E_OPERAND_COUNT", `.word 需要 1 个操作数，实际 ${args.length} 个`);
      } else {
        const tok = args[0];
        let value: number | null = null;
        if (/^0x[0-9a-fA-F]+$/.test(tok)) value = parseInt(tok, 16);
        else if (/^[0-9]+$/.test(tok)) value = parseInt(tok, 10);
        if (value === null) {
          err(diagnostics, line, "E_BAD_WORD", `.word 常量非法: ${tok}（仅支持十进制或 0x 十六进制）`);
        } else if (value > 0xffffffff) {
          err(diagnostics, line, "E_WORD_RANGE", `.word 常量越界: ${tok}（范围 0..4294967295）`);
        } else {
          word = value >>> 0;
          note = `数据字 ${hex(word, 8)}`;
        }
      }
    } else if (mnemonic === "HALT") {
      if (args.length !== 0) {
        err(diagnostics, line, "E_OPERAND_COUNT", `HALT 不需要操作数，实际 ${args.length} 个`);
      } else {
        word = encodeWord(OPCODES.HALT, 0, 0, 0);
      }
    } else if (mnemonic === "MOVI") {
      if (args.length !== 2) {
        err(diagnostics, line, "E_OPERAND_COUNT", `MOVI 需要 2 个操作数，实际 ${args.length} 个`);
      } else {
        const rd = parseRegister(args[0]);
        if (rd === null) {
          err(diagnostics, line, "E_BAD_REG", `非法寄存器: ${args[0]}（应为 R0..R15）`);
        } else if (!/^-?[0-9]+$/.test(args[1])) {
          err(diagnostics, line, "E_BAD_IMM", `MOVI 立即数须为带可选负号的十进制: ${args[1]}`);
        } else {
          const imm = parseInt(args[1], 10);
          if (imm < -32768 || imm > 32767) {
            err(diagnostics, line, "E_IMM_RANGE", `MOVI 立即数越界: ${imm}（范围 -32768..32767）`);
          } else {
            word = encodeWord(OPCODES.MOVI, rd, 0, imm & 0xffff);
            note = `MOVI R${rd}, ${imm}`;
          }
        }
      }
    } else if (mnemonic === "ADD") {
      if (args.length !== 2) {
        err(diagnostics, line, "E_OPERAND_COUNT", `ADD 需要 2 个操作数，实际 ${args.length} 个`);
      } else {
        const rd = parseRegister(args[0]);
        const rs = parseRegister(args[1]);
        if (rd === null) err(diagnostics, line, "E_BAD_REG", `非法寄存器: ${args[0]}（应为 R0..R15）`);
        if (rs === null) err(diagnostics, line, "E_BAD_REG", `非法寄存器: ${args[1]}（应为 R0..R15）`);
        if (rd !== null && rs !== null) {
          word = encodeWord(OPCODES.ADD, rd, rs, 0);
          note = `ADD R${rd}, R${rs}`;
        }
      }
    } else if (mnemonic === "JMP" || mnemonic === "JZ") {
      const need = mnemonic === "JMP" ? 1 : 2;
      if (args.length !== need) {
        err(diagnostics, line, "E_OPERAND_COUNT", `${mnemonic} 需要 ${need} 个操作数，实际 ${args.length} 个`);
      } else {
        let r1 = 0;
        let regOk = true;
        if (mnemonic === "JZ") {
          const rd = parseRegister(args[0]);
          if (rd === null) {
            err(diagnostics, line, "E_BAD_REG", `非法寄存器: ${args[0]}（应为 R0..R15）`);
            regOk = false;
          } else r1 = rd;
        }
        const label = args[args.length - 1];
        if (!IDENT_RE.test(label)) {
          err(diagnostics, line, "E_BAD_LABEL", `非法标签名: ${label}`);
        } else if (!labelMap.has(label)) {
          err(diagnostics, line, "E_UNDEF_LABEL", `未定义标签: ${label}`);
        } else {
          const target = labelMap.get(label)!;
          const targetItem = itemByAddress.get(target.address);
          if (target.address >= endAddress || !targetItem) {
            err(diagnostics, line, "E_JUMP_EOF",
              `跳转目标 ${label} 位于文件末端（地址 ${hex(target.address)}），没有可执行指令`);
          } else if (targetItem.kind !== "instruction") {
            err(diagnostics, line, "E_JUMP_TO_DATA",
              `跳转目标 ${label} 指向数据项（地址 ${hex(target.address)}）`);
          } else {
            const nextAddress = addr + 4;
            const byteDelta = target.address - nextAddress;
            const offset = byteDelta / 4;
            if (offset < -32768 || offset > 32767) {
              err(diagnostics, line, "E_JUMP_RANGE",
                `跳转偏移 ${offset} 字超出有符号 16 位范围（-32768..32767）`);
            } else if (regOk) {
              word = encodeWord(OPCODES[mnemonic], r1, 0, offset & 0xffff);
              note = `${mnemonic} 下一条地址=${hex(nextAddress)} 目标=${label}@${hex(target.address)} 偏移=${offset}`;
              jumps.push({
                address: addr,
                mnemonic,
                label,
                nextAddress,
                targetAddress: target.address,
                offset,
              });
            }
          }
        }
      }
    }
    // 未知指令已在第一遍报错

    const itemBytes = word === null ? null : wordToBytesLE(word);
    if (itemBytes) bytes.push(...itemBytes);
    else bytes.push(0, 0, 0, 0); // 占位，失败时不会发布
    const entry = listingByLine.get(line);
    if (entry) {
      entry.address = addr;
      entry.bytes = itemBytes;
      entry.note = note;
    }
  }

  if (diagnostics.length > 0) return fail(diagnostics, listing, symbols, jumps);
  return {
    ok: true,
    isaVersion: ISA_VERSION,
    binary: Buffer.from(bytes),
    symbols,
    diagnostics,
    listing,
    jumps,
  };
}

function fail(
  diagnostics: Diagnostic[],
  listing: ListingEntry[],
  symbols: SymbolEntry[],
  jumps: JumpInfo[]
): AssembleResult {
  return {
    ok: false,
    isaVersion: ISA_VERSION,
    binary: null,
    symbols,
    diagnostics,
    listing,
    jumps,
  };
}

/** 从清单/二进制独立解码跳转字，恢复目标地址（用于核验）。 */
export function decodeJumpTarget(word: number, address: number): {
  opcode: number;
  offset: number;
  targetAddress: number;
} {
  const opcode = (word >>> 24) & 0xff;
  let imm = word & 0xffff;
  if (imm & 0x8000) imm -= 0x10000; // 符号扩展
  return { opcode, offset: imm, targetAddress: address + 4 + imm * 4 };
}
