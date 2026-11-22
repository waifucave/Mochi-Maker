/**
 * The MCP server's caps on what it is handed (core's LIMITS): a message on standard input past
 * its cap is answered "too large" without being kept, and art sent to the editor through the
 * bridge is checked by its files' sizes before any is read.
 */
import { PassThrough } from 'node:stream';
import { mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@mochi-maker/core';
import { MAX_MESSAGE } from '@mochi-maker/bridge';
import { MochiMcpServer, serveStdio } from '@mochi-maker/mcp';
import { BridgeBackend } from '../src/backend.js';
import { lines } from '../src/stdio.js';

const MiB = 2 ** 20;

describe('standard input', () => {
  it('answers a message past the cap with "too large", and goes on with the next', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mochi-mcp-'));
    const server = new MochiMcpServer({ allowDirs: [root] });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => (text += String(c)));
    const done = serveStdio(server, input, output, 1024);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    // 5,000 bytes, written in pieces, then a newline.
    for (let i = 0; i < 5; i++) input.write('x'.repeat(1000));
    input.write('\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    input.end();
    await done;
    const replies = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(replies.map((r) => r.id)).toEqual([1, null, 2]);
    expect(replies[1].error.message).toMatch(/too large: more than the 1 KiB/);
    expect(replies[2].result.tools.length).toBeGreaterThan(0);
  });

  it('keeps nothing of a 512 MiB message while it streams in', async () => {
    async function* stream() {
      const piece = Buffer.alloc(MiB, 0x61);
      for (let i = 0; i < 512; i++) yield piece;
      yield Buffer.from('\n{"ok":1}\n');
    }
    const base = process.memoryUsage();
    let peak = 0;
    const out: unknown[] = [];
    let n = 0;
    const sample = () => {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.arrayBuffers + m.heapUsed - base.arrayBuffers - base.heapUsed);
    };
    const counted = (async function* () {
      for await (const c of stream()) {
        if (++n % 16 === 0) sample();
        yield c;
      }
    })();
    for await (const item of lines(counted, LIMITS.mcpMessageBytes)) out.push(item);
    sample();
    expect(out).toEqual([{ tooLong: 512 * MiB }, { line: '{"ok":1}' }]);
    // The cap is 64 MiB; what is kept stays far below the 512 MiB that came in.
    expect(peak).toBeLessThan(LIMITS.mcpMessageBytes + 32 * MiB);
  }, 60_000);
});

describe('art sent through the bridge', () => {
  /** A bridge backend whose client records the commands it would send. */
  function backend() {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const client = {
      command: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return {};
      },
    };
    const b = Object.create(BridgeBackend.prototype) as BridgeBackend;
    Object.defineProperty(b, 'client', { value: client });
    return { b, calls };
  }

  it('refuses art that does not fit in one bridge message, before reading it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-mcp-art-'));
    const big = join(dir, 'big.psd');
    writeFileSync(big, '');
    truncateSync(big, MAX_MESSAGE); // sparse: nothing is written, and nothing is read
    const { b, calls } = backend();
    const e = await b.importArt(big, {}, false).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'E_TOO_LARGE' });
    expect((e as Error).message).toMatch(/sent through the bridge, is too large: 16 MiB/);
    expect(calls).toEqual([]);
    // A small file goes as base64.
    const small = join(dir, 'small.png');
    writeFileSync(small, Buffer.from([1, 2, 3]));
    await b.importArt(small, {}, true);
    expect(calls[0]).toMatchObject({
      name: 'import_art',
      args: { files: { 'small.png': 'AQID' }, path: 'small.png', dryRun: true },
    });
  });
});
