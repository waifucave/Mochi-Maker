/** The stdio transport: newline-delimited JSON-RPC messages on stdin and stdout. */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { MochiMcpServer } from './server.js';

export async function serveStdio(
  server: MochiMcpServer,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<void> {
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + '\n');
  server.onNotify((method, params) => send({ jsonrpc: '2.0', method, params }));
  const lines = createInterface({ input, crlfDelay: Infinity });
  // Requests are handled one at a time, in order, so transactions never interleave.
  let queue = Promise.resolve();
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
      continue;
    }
    queue = queue.then(async () => {
      const r = await server.handle(msg);
      if (r) send(r);
    });
  }
  await queue;
  await server.close();
}
