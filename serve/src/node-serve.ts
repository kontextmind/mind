/**
 * node:http ↔ Web Request/Response bridge. The app handler is runtime-
 * agnostic (standard fetch types), so npx (Node) and bunx (Bun) ship the
 * same bundle: Bun.serve when available, this bridge otherwise.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

function toWebHeaders(req: IncomingMessage): Headers {
  const h = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i].toLowerCase();
    if (k === "host" || k === "content-length" || k === "connection") continue;
    h.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  return h;
}

export function nodeServe(
  handler: (req: Request) => Response | Promise<Response>,
  port: number,
  hostname: string,
): Promise<{ port: number; close: () => void }> {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const host = req.headers.host ?? `${hostname}:${port}`;
      const request = new Request(`http://${host}${req.url}`, {
        method: req.method,
        headers: toWebHeaders(req),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.appendHeader(k, v));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.statusCode = 500;
      res.end(JSON.stringify({ error: "internal", detail: String((err as Error)?.message ?? err) }));
    }
  });
  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      const actual = (server.address() as AddressInfo).port;
      resolveP({ port: actual, close: () => server.close() });
    });
  });
}
