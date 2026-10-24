#!/usr/bin/env node
import http from "node:http";
import { handleToss } from "./toss.mjs";

function parsePort(argv) {
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`잘못된 --port: ${argv[idx + 1]}`);
    return n;
  }
  return 4010;
}

const port = parsePort(process.argv.slice(2));

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? `127.0.0.1:${port || 4010}`;
    const url = new URL(req.url ?? "/", `http://${host}`);
    const pathname = url.pathname;
    const origin = `http://${host}`;

    if (await handleToss(req, res, pathname, url)) return;

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`not found: ${pathname}`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end(err instanceof Error ? err.message : String(err));
  }
});

server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  // vitest 하네스가 이 한 줄을 파싱한다.
  console.log(`LISTENING:${actual}`);
});
