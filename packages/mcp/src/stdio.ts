/**
 * The stdio transport: newline-delimited JSON-RPC messages on stdin and stdout. A message longer
 * than LIMITS.mcpMessageBytes is not kept: its bytes are dropped as they arrive, up to the next
 * newline, and it is answered with an error that says it is too large.
 */
import type { Readable, Writable } from 'node:stream';
import { LIMITS, formatSize } from '@mochi-maker/core';
import type { MochiMcpServer } from './server.js';

/** Splits a byte stream into lines, dropping (and reporting) any line longer than `max` bytes. */
export async function* lines(
  input: AsyncIterable<Buffer | string>,
  max: number,
): AsyncGenerator<{ line: string } | { tooLong: number }> {
  let parts: Buffer[] = [];
  let length = 0;
  let dropping = 0;
  for await (const chunk of input) {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    for (;;) {
      const nl = buf.indexOf(10);
      const piece = nl < 0 ? buf : buf.subarray(0, nl);
      if (dropping > 0) dropping += piece.length;
      else if (length + piece.length > max) {
        dropping = length + piece.length;
        parts = [];
        length = 0;
      } else {
        parts.push(piece);
        length += piece.length;
      }
      if (nl < 0) break;
      if (dropping > 0) yield { tooLong: dropping };
      else yield { line: Buffer.concat(parts).toString('utf8').replace(/\r$/, '') };
      parts = [];
      length = 0;
      dropping = 0;
      buf = buf.subarray(nl + 1);
    }
  }
  if (dropping > 0) yield { tooLong: dropping };
  else if (length > 0) yield { line: Buffer.concat(parts).toString('utf8').replace(/\r$/, '') };
}

export async function serveStdio(
  server: MochiMcpServer,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  maxMessage: number = LIMITS.mcpMessageBytes,
): Promise<void> {
  const send = (msg: unknown) => output.write(JSON.stringify(msg) + '\n');
  server.onNotify((method, params) => send({ jsonrpc: '2.0', method, params }));
  // Requests are handled one at a time, in order, so transactions never interleave.
  // Errors for messages that cannot be read wait their turn too, so replies follow the input.
  let queue = Promise.resolve();
  const later = (msg: unknown) => (queue = queue.then(() => void send(msg)));
  for await (const item of lines(input, maxMessage)) {
    if ('tooLong' in item) {
      later({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: `The message is too large: more than the ${formatSize(maxMessage)} the Mochi Maker MCP server accepts.`,
        },
      });
      continue;
    }
    const line = item.line;
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      later({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
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
