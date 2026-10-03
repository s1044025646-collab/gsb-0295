import * as http from "node:http";
import { Store } from "./db.js";
import { assemble, decodeJumpTarget } from "./assembler.js";

const MAX_BODY = 256 * 1024;

function sendJson(res: http.ServerResponse, status: number, obj: unknown) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("E_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      // POST /api/assemble
      if (method === "POST" && url.pathname === "/api/assemble") {
        let body: string;
        try {
          body = await readBody(req);
        } catch {
          return sendError(res, 413, "E_TOO_LARGE", "请求体过大");
        }
        let parsed: { source?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          return sendError(res, 400, "E_BAD_JSON", "请求体不是合法 JSON");
        }
        if (typeof parsed.source !== "string" || parsed.source.length === 0) {
          return sendError(res, 400, "E_VALIDATION", "字段 source 必须是非空字符串");
        }
        const result = assemble(parsed.source);
        const id = store.saveProgram(parsed.source, result);
        return sendJson(res, result.ok ? 200 : 422, {
          id,
          status: result.ok ? "ok" : "failed",
          symbols: result.symbols,
          listing: result.listing,
          diagnostics: result.diagnostics,
          size: result.binary ? result.binary.length : null,
        });
      }

      // GET /api/programs
      if (method === "GET" && url.pathname === "/api/programs") {
        const rows = store.listPrograms().map((p) => ({
          id: p.id, isa_version: p.isa_version, status: p.status,
          sha256: p.sha256, size: p.size, created_at: p.created_at,
        }));
        return sendJson(res, 200, rows);
      }

      if (parts[0] === "api" && parts[1] === "programs" && parts.length >= 3) {
        const id = Number(parts[2]);
        if (!Number.isInteger(id) || id <= 0) {
          return sendError(res, 400, "E_VALIDATION", "程序 id 必须是正整数");
        }
        const program = store.getProgram(id);
        if (!program) return sendError(res, 404, "E_NOT_FOUND", `程序 ${id} 不存在`);
        const sub = parts[3];

        if (method === "GET" && parts.length === 3) {
          return sendJson(res, 200, {
            ...program,
            symbols: store.getSymbols(id),
            diagnostics: store.getDiagnostics(id),
          });
        }
        if (method === "GET" && sub === "symbols") {
          return sendJson(res, 200, store.getSymbols(id));
        }
        if (method === "GET" && sub === "diagnostics") {
          return sendJson(res, 200, store.getDiagnostics(id));
        }
        if (method === "GET" && sub === "listing") {
          const art = store.getArtifact(id);
          if (!art) return sendError(res, 404, "E_NO_ARTIFACT", "该程序汇编失败，无产物清单");
          return sendJson(res, 200, JSON.parse(art.listing));
        }
        if (method === "GET" && sub === "binary") {
          const art = store.getArtifact(id);
          if (!art) return sendError(res, 404, "E_NO_ARTIFACT", "该程序汇编失败，无可下载二进制");
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="program-${id}.bin"`,
          });
          return res.end(art.binary);
        }
        if (method === "GET" && sub === "jumps") {
          const addrStr = parts[4];
          const addr = Number(addrStr);
          if (!Number.isInteger(addr) || addr < 0) {
            return sendError(res, 400, "E_VALIDATION", "跳转地址必须是非负整数（十进制或 0x 前缀）");
          }
          const art = store.getArtifact(id);
          if (!art) return sendError(res, 404, "E_NO_ARTIFACT", "该程序汇编失败，无产物");
          try {
            const decoded = decodeJumpTarget(art.binary, addr);
            return sendJson(res, 200, { address: addr, ...decoded });
          } catch (e) {
            return sendError(res, 400, "E_NOT_JUMP", (e as Error).message);
          }
        }
      }

      return sendError(res, 404, "E_NOT_FOUND", "路由不存在");
    } catch (e) {
      return sendError(res, 500, "E_INTERNAL", (e as Error).message);
    }
  });
}

export function startServer(store: Store, port: number): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer(store);
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      resolve({ port: actual, close: () => server.close() });
    });
  });
}
