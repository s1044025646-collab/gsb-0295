import { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { AssembleResult, Diagnostic, JumpInfo, ListingEntry, SymbolEntry } from "./assembler";

export const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "assemblies.db");

export interface AssemblyRow {
  id: number;
  isa_version: string;
  status: "ok" | "failed";
  source: string;
  size: number | null;
  sha256: string | null;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assemblies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        isa_version TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        size INTEGER,
        sha256 TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        assembly_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        address INTEGER NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostics (
        assembly_id INTEGER NOT NULL,
        line INTEGER NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS listing (
        assembly_id INTEGER NOT NULL,
        line INTEGER NOT NULL,
        source TEXT NOT NULL,
        address INTEGER,
        bytes TEXT,
        note TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jumps (
        assembly_id INTEGER NOT NULL,
        address INTEGER NOT NULL,
        mnemonic TEXT NOT NULL,
        label TEXT NOT NULL,
        next_address INTEGER NOT NULL,
        target_address INTEGER NOT NULL,
        offset INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        assembly_id INTEGER PRIMARY KEY,
        binary BLOB NOT NULL
      );
    `);
  }

  saveAssembly(source: string, result: AssembleResult): number {
    const status = result.ok ? "ok" : "failed";
    const size = result.binary ? result.binary.length : null;
    const sha256 = result.binary
      ? crypto.createHash("sha256").update(result.binary).digest("hex")
      : null;
    const stmt = this.db.prepare(
      `INSERT INTO assemblies (isa_version, status, source, size, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
      result.isaVersion, status, source, size, sha256, new Date().toISOString()
    );
    const id = Number(info.lastInsertRowid);

    const symStmt = this.db.prepare(
      `INSERT INTO symbols (assembly_id, name, address, kind) VALUES (?, ?, ?, ?)`);
    for (const s of result.symbols) symStmt.run(id, s.name, s.address, s.kind);

    const diagStmt = this.db.prepare(
      `INSERT INTO diagnostics (assembly_id, line, code, message) VALUES (?, ?, ?, ?)`);
    for (const d of result.diagnostics) diagStmt.run(id, d.line, d.code, d.message);

    const listStmt = this.db.prepare(
      `INSERT INTO listing (assembly_id, line, source, address, bytes, note) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const l of result.listing) {
      listStmt.run(id, l.line, l.source, l.address,
        l.bytes ? JSON.stringify(l.bytes) : null, l.note);
    }

    const jumpStmt = this.db.prepare(
      `INSERT INTO jumps (assembly_id, address, mnemonic, label, next_address, target_address, offset)
       VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const j of result.jumps) {
      jumpStmt.run(id, j.address, j.mnemonic, j.label, j.nextAddress, j.targetAddress, j.offset);
    }

    if (result.binary) {
      this.db.prepare(`INSERT INTO artifacts (assembly_id, binary) VALUES (?, ?)`)
        .run(id, result.binary);
    }
    return id;
  }

  listAssemblies(): AssemblyRow[] {
    return this.db.prepare(
      `SELECT id, isa_version, status, source, size, sha256, created_at
       FROM assemblies ORDER BY id DESC`).all() as unknown as AssemblyRow[];
  }

  getAssembly(id: number): AssemblyRow | null {
    const row = this.db.prepare(
      `SELECT id, isa_version, status, source, size, sha256, created_at
       FROM assemblies WHERE id = ?`).get(id);
    return (row as unknown as AssemblyRow) ?? null;
  }

  getSymbols(id: number): SymbolEntry[] {
    return this.db.prepare(
      `SELECT name, address, kind FROM symbols WHERE assembly_id = ? ORDER BY address, name`)
      .all(id) as unknown as SymbolEntry[];
  }

  getDiagnostics(id: number): Diagnostic[] {
    return this.db.prepare(
      `SELECT line, code, message FROM diagnostics WHERE assembly_id = ? ORDER BY line`)
      .all(id) as unknown as Diagnostic[];
  }

  getListing(id: number): ListingEntry[] {
    const rows = this.db.prepare(
      `SELECT line, source, address, bytes, note FROM listing WHERE assembly_id = ? ORDER BY line`)
      .all(id) as unknown as { line: number; source: string; address: number | null; bytes: string | null; note: string }[];
    return rows.map((r) => ({
      line: r.line,
      source: r.source,
      address: r.address,
      bytes: r.bytes ? (JSON.parse(r.bytes) as number[]) : null,
      note: r.note,
    }));
  }

  getJumps(id: number): JumpInfo[] {
    const rows = this.db.prepare(
      `SELECT address, mnemonic, label, next_address, target_address, offset
       FROM jumps WHERE assembly_id = ? ORDER BY address`)
      .all(id) as unknown as {
        address: number; mnemonic: string; label: string;
        next_address: number; target_address: number; offset: number;
      }[];
    return rows.map((r) => ({
      address: r.address,
      mnemonic: r.mnemonic as "JMP" | "JZ",
      label: r.label,
      nextAddress: r.next_address,
      targetAddress: r.target_address,
      offset: r.offset,
    }));
  }

  getJumpAt(id: number, address: number): JumpInfo | null {
    return this.getJumps(id).find((j) => j.address === address) ?? null;
  }

  getBinary(id: number): Buffer | null {
    const row = this.db.prepare(
      `SELECT binary FROM artifacts WHERE assembly_id = ?`).get(id) as
      { binary: Buffer } | undefined;
    return row ? Buffer.from(row.binary) : null;
  }

  close() {
    this.db.close();
  }
}
