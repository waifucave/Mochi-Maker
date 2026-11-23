/**
 * One version everywhere: the root package.json's (docs/desktop.md, "Releases"). Every package,
 * the core's VERSION and what carries it (the project writer, the export's producer, the API),
 * the command line's --version, the MCP server, the bridge, the editor's bridge host, the desktop
 * app (its package.json, About panel and file properties come from identity.mjs), the
 * conformance pack's producer, and a CHANGELOG.md section for it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { VERSION } from '@mochi-maker/core';
import { WRITER } from '../../core/src/project.js';
import { VERSION as API_VERSION } from '@mochi-maker/api';
import { BRIDGE_VERSION } from '@mochi-maker/bridge';
import { MochiMcpServer, SERVER_VERSION } from '@mochi-maker/mcp';
import { exportModel } from '@mochi-maker/export';
import { main } from '../src/main.js';
import { golden1 } from '../../export/test/golden.js';
import { APP_VERSION } from '../../desktop/identity.mjs';
import { releaseProblems } from '../../desktop/release-check.mjs';

const ROOT = join(import.meta.dirname, '../../..');
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const V = json('package.json').version as string;

describe('one version', () => {
  it('is 0.1.0, a version', () => {
    expect(V).toBe('0.1.0');
  });

  it('is every package’s, and every dependency between them', () => {
    for (const dir of readdirSync(join(ROOT, 'packages'))) {
      const p = json(`packages/${dir}/package.json`);
      expect(p.version, dir).toBe(V);
      for (const deps of [p.dependencies, p.devDependencies])
        for (const [name, range] of Object.entries(deps ?? {}))
          if (name.startsWith('@mochi-maker/')) expect(range, `${dir} → ${name}`).toBe(V);
    }
  });

  it('is what the core, the API, the bridge and the MCP server say', async () => {
    expect(VERSION).toBe(V);
    expect(API_VERSION).toBe(V);
    expect(WRITER).toBe(`@mochi-maker/core ${V}`);
    expect(BRIDGE_VERSION).toBe(V);
    expect(SERVER_VERSION).toBe(V);
    const server = new MochiMcpServer({ allowDirs: [] });
    const r = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    })) as {
      result: { serverInfo: { version: string } };
    };
    expect(r.result.serverInfo.version).toBe(V);
    await server.close();
    // The editor's bridge host introduces itself with the core's VERSION.
    expect(readFileSync(join(ROOT, 'packages/editor/src/host.ts'), 'utf8')).toMatch(
      /app: 'mochi-maker',\s+version: VERSION,/,
    );
  });

  it('is the command line’s --version', async () => {
    let out = '';
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s) => ((out += String(s)), true));
    try {
      expect(await main(['--version'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(out).toBe(`${V}\n`);
  });

  it('is in what an export and the conformance pack carry', async () => {
    const g = await golden1();
    const r = await exportModel(g.session.doc, g.assets);
    expect(r.report.producer).toMatch(
      new RegExp(`^@mochi-maker/export ${V.replace(/\./g, '\\.')} with mochi2d `),
    );
    expect(json('conformance/manifest.json').producer).toBe(`mochi-maker ${V}`);
    expect(readFileSync(join(ROOT, 'conformance/README.md'), 'utf8').split('\n')[2]).toMatch(
      new RegExp(`^Written by mochi-maker ${V.replace(/\./g, '\\.')},`),
    );
  });

  it('is the desktop app’s, and has its section in CHANGELOG.md', () => {
    expect(APP_VERSION).toBe(V);
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    expect(releaseProblems({ version: V, changelog, tag: `v${V}` })).toEqual([]);
  });
});
