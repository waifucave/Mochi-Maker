/**
 * Model import through the API, the MCP server and the command line: a model folder from the
 * conformance pack (Mochi Maker's own export of golden 1) becomes a saved project, with the import
 * report, the notice, and the same model again on export.
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DocView } from '@mochi-maker/core';
import { MODEL_IMPORT_NOTICE } from '@mochi-maker/export';
import { Project } from '@mochi-maker/api';
import { MochiMcpServer } from '@mochi-maker/mcp';
import { main } from '../../cli/src/main.js';

const PACK = join(import.meta.dirname, '../../../conformance');
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mochi-import-model-'));
  await cp(join(PACK, 'golden-1-keyforms/v5/model'), join(root, 'model'), { recursive: true });
  await cp(join(PACK, 'golden-5-glue/v5/model'), join(root, 'glue'), { recursive: true });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('model import: API, MCP and CLI', () => {
  it('the API imports a folder into a new project, saved, with the report and the notice', async () => {
    const r = await Project.importModel(join(root, 'model'), join(root, 'api.mochi'), {
      date: '2026-11-20T00:00:00.000Z',
    });
    expect(r.notices).toEqual([MODEL_IMPORT_NOTICE]);
    expect(r.report.reconstructed).toMatchObject({ parameters: 1, artMeshes: 1, texturePages: 1 });
    expect(r.project.dirty).toBe(false);
    const again = await Project.open(join(root, 'api.mochi'));
    const origin = new DocView(again.session.doc).project().importedFrom!;
    expect(origin).toEqual({
      format: 'moc3',
      date: '2026-11-20T00:00:00.000Z',
      mocVersion: 5,
      files: [
        'golden1.1024/texture_00.png',
        'golden1.cdi3.json',
        'golden1.moc3',
        'golden1.model3.json',
      ],
      keep: expect.objectContaining({ canvasFlags: 0, ranges: [], values: [] }),
    });
    const out = await again.exportResult();
    const original = await readFile(join(root, 'model/golden1.moc3'));
    expect(Buffer.from(out.files.get('golden1.moc3')!).equals(original)).toBe(true);
    // Naming the .model3.json works too; a folder that already holds a project is refused.
    await Project.importModel(join(root, 'model/golden1.model3.json'), join(root, 'api2.mochi'));
    await expect(Project.importModel(join(root, 'model'), join(root, 'api.mochi'))).rejects.toThrow(
      /already contains a project/,
    );
  });

  it('the MCP server imports into an allowed folder and returns the notice', async () => {
    const server = new MochiMcpServer({ allowDirs: [root], author: 'agent:test' });
    const res = (
      (await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'mochi_project',
          arguments: {
            action: 'importModel',
            model: join(root, 'glue'),
            path: join(root, 'mcp.mochi'),
          },
        },
      })) as Json
    ).result as Json;
    expect(res.isError).toBeFalsy();
    const s = res.structuredContent as Json;
    expect(s.notices).toEqual([MODEL_IMPORT_NOTICE]);
    expect(s.report.features.glue).toBe(true);
    expect(s.report.features.lines.join(' ')).toMatch(
      /does not export while the glue feature is off/,
    );
    // Outside the allowed folders: refused.
    const denied = (
      (await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'mochi_project',
          arguments: { action: 'importModel', model: '/etc', path: join(root, 'x.mochi') },
        },
      })) as Json
    ).result as Json;
    expect(denied.isError).toBe(true);
  });

  it('the command line prints the notice as one line on standard error', async () => {
    let stdout = '';
    let stderr = '';
    const o = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s) => ((stdout += String(s)), true));
    const e = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((s) => ((stderr += String(s)), true));
    let code: number;
    try {
      code = await main(['import-model', join(root, 'model'), join(root, 'cli.mochi')]);
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
    expect(code).toBe(0);
    expect(stderr).toBe(MODEL_IMPORT_NOTICE + '\n');
    expect(stdout).toMatch(
      /Imported golden1.model3.json \(.moc3 version 5\): 1 parameter, 1 part, 1 art mesh, 1 texture page/,
    );
  });
});
