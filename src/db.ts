import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import { AssembleResult, ISA_VERSION } from "./assembler.js";

export interface ProgramRow {
  id: number;
  isa_version: string;
  source: string;
  status: string;
  sha256: string | null;
  size: number | null;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "assembler.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        isa_version TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        sha256 TEXT,
        size INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symbols (
        program_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        address INTEGER NOT NULL,
        kind TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostics (
        program_id INTEGER NOT NULL,
        line INTEGER NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        program_id INTEGER PRIMARY KEY,
        binary BLOB NOT NULL,
        listing TEXT NOT NULL
      );
    `);
  }

  saveProgram(source: string, result: AssembleResult): number {
    const status = result.ok ? "ok" : "failed";
    const sha = result.binary ? createHash("sha256").update(result.binary).digest("hex") : null;
    const size = result.binary ? result.binary.length : null;
    const info = this.db
      .prepare("INSERT INTO programs (isa_version, source, status, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ISA_VERSION, source, status, sha, size, new Date().toISOString());
    const id = Number(info.lastInsertRowid);

    const symStmt = this.db.prepare("INSERT INTO symbols (program_id, name, address, kind) VALUES (?, ?, ?, ?)");
    for (const s of result.symbols) symStmt.run(id, s.name, s.address, s.kind);

    const diagStmt = this.db.prepare("INSERT INTO diagnostics (program_id, line, code, message) VALUES (?, ?, ?, ?)");
    for (const d of result.diagnostics) diagStmt.run(id, d.line, d.code, d.message);

    if (result.binary) {
      this.db
        .prepare("INSERT INTO artifacts (program_id, binary, listing) VALUES (?, ?, ?)")
        .run(id, result.binary, JSON.stringify(result.listing));
    }
    return id;
  }

  listPrograms(): ProgramRow[] {
    return this.db.prepare("SELECT * FROM programs ORDER BY id DESC").all() as unknown as ProgramRow[];
  }

  getProgram(id: number): ProgramRow | null {
    return (this.db.prepare("SELECT * FROM programs WHERE id = ?").get(id) as unknown as ProgramRow) ?? null;
  }

  getSymbols(id: number) {
    return this.db.prepare("SELECT name, address, kind FROM symbols WHERE program_id = ? ORDER BY address, name").all(id);
  }

  getDiagnostics(id: number) {
    return this.db.prepare("SELECT line, code, message FROM diagnostics WHERE program_id = ? ORDER BY line").all(id);
  }

  getArtifact(id: number): { binary: Buffer; listing: string } | null {
    const row = this.db.prepare("SELECT binary, listing FROM artifacts WHERE program_id = ?").get(id) as
      | { binary: Uint8Array; listing: string }
      | undefined;
    if (!row) return null;
    return { binary: Buffer.from(row.binary), listing: row.listing };
  }

  close() {
    this.db.close();
  }
}
