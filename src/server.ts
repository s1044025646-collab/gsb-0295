import * as http from "node:http";
import { AddressInfo } from "node:net";
import { assemble } from "./assembler";
import { Store } from "./db";

const MAX_BODY_BYTES = 2 << 20; // 2 MiB 请求体上限

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function apiError(res: http.ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("E_BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseId(seg: string | undefined): number | null {
  if (!seg || !/^\d+$/.test(seg)) return null;
  return parseInt(seg, 10);
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","assemblies","1","binary"]
    try {
      // POST /api/assemble  { "source": "..." }
      if (req.method === "POST" && url.pathname === "/api/assemble") {
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          return apiError(res, 400, "E_BAD_JSON", "请求体不是合法 JSON");
        }
        const source = (parsed as { source?: unknown }).source;
        if (typeof source !== "string" || source.length === 0) {
          return apiError(res, 400, "E_BAD_SOURCE", "字段 source 必须是非空字符串");
        }
        const result = assemble(source);
        const id = store.saveAssembly(source, result);
        return sendJson(res, result.ok ? 200 : 422, {
          id,
          ok: result.ok,
          isaVersion: result.isaVersion,
          size: result.binary ? result.binary.length : null,
          symbols: result.symbols,
          diagnostics: result.diagnostics,
          listing: result.listing,
          jumps: result.jumps,
        });
      }

      // GET /api/assemblies  历史列表
      if (req.method === "GET" && url.pathname === "/api/assemblies") {
        const rows = store.listAssemblies().map((r) => ({
          id: r.id, isaVersion: r.isa_version, status: r.status,
          size: r.size, sha256: r.sha256, createdAt: r.created_at,
        }));
        return sendJson(res, 200, { assemblies: rows });
      }

      if (parts[0] === "api" && parts[1] === "assemblies" && parts.length >= 3) {
        const id = parseId(parts[2]);
        if (id === null) return apiError(res, 400, "E_BAD_ID", "程序集 id 必须是非负整数");
        const row = store.getAssembly(id);
        if (!row) return apiError(res, 404, "E_NOT_FOUND", `不存在 id=${id} 的汇编记录`);
        const sub = parts[3];

        // GET /api/assemblies/:id  详情（符号 + 清单 + 诊断）
        if (req.method === "GET" && sub === undefined) {
          return sendJson(res, 200, {
            id: row.id,
            isaVersion: row.isa_version,
            status: row.status,
            size: row.size,
            sha256: row.sha256,
            createdAt: row.created_at,
            source: row.source,
            symbols: store.getSymbols(id),
            diagnostics: store.getDiagnostics(id),
            listing: store.getListing(id),
            jumps: store.getJumps(id),
          });
        }

        // GET /api/assemblies/:id/symbols
        if (req.method === "GET" && sub === "symbols") {
          return sendJson(res, 200, { id, symbols: store.getSymbols(id) });
        }

        // GET /api/assemblies/:id/listing
        if (req.method === "GET" && sub === "listing") {
          return sendJson(res, 200, { id, listing: store.getListing(id) });
        }

        // GET /api/assemblies/:id/jump?address=N  查询某条跳转
        if (req.method === "GET" && sub === "jump") {
          const addrStr = url.searchParams.get("address");
          if (addrStr === null || !/^\d+$/.test(addrStr)) {
            return apiError(res, 400, "E_BAD_ADDRESS", "查询参数 address 必须是非负整数字节地址");
          }
          const jump = store.getJumpAt(id, parseInt(addrStr, 10));
          if (!jump) {
            return apiError(res, 404, "E_NO_JUMP",
              `地址 ${addrStr} 处没有跳转指令（或该地址未对齐到指令起点）`);
          }
          return sendJson(res, 200, { id, jump });
        }

        // GET /api/assemblies/:id/binary  导出二进制
        if (req.method === "GET" && sub === "binary") {
          const binary = store.getBinary(id);
          if (!binary) {
            return apiError(res, 409, "E_NO_ARTIFACT",
              "该记录汇编失败，不存在可下载的二进制产物");
          }
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="assembly-${id}.bin"`,
            "Content-Length": binary.length,
          });
          return res.end(binary);
        }
      }

      return apiError(res, 404, "E_ROUTE", "未知路由");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "E_BODY_TOO_LARGE") {
        return apiError(res, 413, "E_BODY_TOO_LARGE", "请求体超过大小上限");
      }
      return apiError(res, 500, "E_INTERNAL", `服务器内部错误: ${msg}`);
    }
  });
}

export function startServer(port: number): Promise<{ server: http.Server; port: number }> {
  const store = new Store();
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({ server, port: actual });
    });
  });
}

if (require.main === module) {
  // 默认 0 = 由系统分配空闲端口；可用 PORT 环境变量或 --port 指定
  const argPort = process.argv.find((a) => a.startsWith("--port="));
  const port = argPort
    ? parseInt(argPort.split("=")[1], 10)
    : parseInt(process.env.PORT ?? "0", 10);
  startServer(Number.isNaN(port) ? 0 : port).then(({ port: actual }) => {
    console.log(`汇编服务已启动: http://127.0.0.1:${actual}`);
  });
}
