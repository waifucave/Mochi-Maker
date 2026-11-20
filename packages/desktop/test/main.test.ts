/**
 * The desktop build's main-process paths, in Node without Electron: checked paths,
 * project and export folders, auto-saved copies and crash detection, recent projects, and the
 * bridge endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { PathGuard, ForbiddenPath } from '../src/guard.js';
import { readFolder, writeFolder, writeProject } from '../src/projectfs.js';
import { Autosaves } from '../src/autosave.js';
import { Recent, MAX_RECENT } from '../src/recent.js';
import { startBridge } from '../src/bridge.js';

let root: string;
const enc = (s: string) => new TextEncoder().encode(s);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mochi-desktop-'));
});
afterAll(() => undefined);

describe('PathGuard', () => {
  it('allows only chosen folders and files, through symbolic links too', async () => {
    const g = new PathGuard();
    const chosen = join(root, 'chosen');
    const other = join(root, 'other');
    await mkdir(chosen, { recursive: true });
    await mkdir(other, { recursive: true });
    await g.allow(chosen);
    expect(await g.check(join(chosen, 'a', 'b.json'))).toBe(join(chosen, 'a', 'b.json'));
    await expect(g.check(join(other, 'x'))).rejects.toBeInstanceOf(ForbiddenPath);
    await expect(g.check(join(chosen, '..', 'other', 'x'))).rejects.toThrow(/outside/);
    await expect(g.check('relative/path')).rejects.toThrow(/absolute/);
    await expect(g.check(`${chosen}/a\0b`)).rejects.toThrow(/non-empty string/);
    await expect(g.check(42)).rejects.toThrow();
    // A link inside the chosen folder that leads out is outside.
    await symlink(other, join(chosen, 'escape'));
    await expect(g.check(join(chosen, 'escape', 'x'))).rejects.toThrow(/outside/);
    // One chosen file allows that file only.
    await writeFile(join(other, 'art.png'), 'x');
    await g.allow(join(other, 'art.png'));
    expect(await g.check(join(other, 'art.png'))).toBe(join(other, 'art.png'));
    await expect(g.check(join(other, 'secret.txt'))).rejects.toThrow(/outside/);
  });
});

describe('project and export folders', () => {
  it('saves a project exactly, leaving other files alone, and refuses other paths', async () => {
    const dir = join(root, 'Hana.mochi');
    await writeProject(dir, [
      ['mochi-project.json', enc('{}')],
      ['meshes/mesh_0001.json', enc('1')],
      ['meshes/mesh_0002.json', enc('2')],
    ]);
    await writeFile(join(dir, 'notes.txt'), 'mine');
    await writeProject(dir, [
      ['mochi-project.json', enc('{"v":2}')],
      ['meshes/mesh_0002.json', enc('2')],
    ]);
    expect((await readFolder(dir)).map(([p]) => p).sort()).toEqual([
      'meshes/mesh_0002.json',
      'mochi-project.json',
      'notes.txt',
    ]);
    expect(await readFile(join(dir, 'mochi-project.json'), 'utf8')).toBe('{"v":2}');
    // No temporary files are left behind.
    expect((await readdir(dir)).some((n) => n.endsWith('.tmp'))).toBe(false);
    await expect(writeProject(dir, [['../evil.json', enc('x')]])).rejects.toThrow(/not a file/);
    await expect(writeProject(dir, [['notes.txt', enc('x')]])).rejects.toThrow(/not a file/);
  });

  it('exports into a folder, relative paths only', async () => {
    const dir = join(root, 'export');
    await writeFolder(dir, [
      ['hana.moc3', enc('m')],
      ['hana.1024/texture_00.png', enc('p')],
    ]);
    expect((await readFolder(dir)).map(([p]) => p).sort()).toEqual([
      'hana.1024/texture_00.png',
      'hana.moc3',
    ]);
    await expect(writeFolder(dir, [['../out.txt', enc('x')]])).rejects.toThrow(/relative/);
    await expect(writeFolder(dir, [['/etc/x', enc('x')]])).rejects.toThrow(/relative/);
  });
});

describe('auto-saved copies', () => {
  it('keeps the newest five per project, and offers them after a crash', async () => {
    let t = 1000;
    const a = new Autosaves(join(root, 'autosave'), 5, () => t);
    await a.begin();
    expect(a.crashed).toBe(false);
    for (let i = 0; i < 7; i++) {
      t += 60_000;
      await a.save({ key: 'p1', name: 'Hana', dir: null }, [
        ['mochi-project.json', enc(`{"n":${i}}`)],
      ]);
    }
    expect((await readdir(join(root, 'autosave', 'p1'))).length).toBe(5);
    const [latest] = await a.latest();
    expect(latest).toMatchObject({ key: 'p1', name: 'Hana', time: t });
    expect(new TextDecoder().decode((await a.read('p1', t))[0]![1])).toBe('{"n":6}');
    // The app dies without ending the session: the next start sees it.
    const next = new Autosaves(join(root, 'autosave'));
    await next.begin();
    expect(next.crashed).toBe(true);
    await next.end();
    const clean = new Autosaves(join(root, 'autosave'));
    await clean.begin();
    expect(clean.crashed).toBe(false);
    // A save clears the project's copies.
    await clean.clear('p1');
    expect(await clean.latest()).toEqual([]);
    await expect(clean.save({ key: '../x', name: 'x', dir: null }, [])).rejects.toThrow(/key/);
  });
});

describe('recent projects', () => {
  it('lists the last ten folders that still exist, newest first', async () => {
    const r = new Recent(join(root, 'recent.json'));
    const dirs: string[] = [];
    for (let i = 0; i < 12; i++) {
      const d = join(root, `p${i}.mochi`);
      await mkdir(d, { recursive: true });
      dirs.push(d);
      await r.add(d);
    }
    await r.add(dirs[5]!);
    const list = await r.list();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]).toBe(dirs[5]);
    expect(list).not.toContain(dirs[0]);
    await r.add(join(root, 'gone.mochi'));
    expect(await r.list()).not.toContain(join(root, 'gone.mochi'));
  });
});

describe('the bridge endpoint', () => {
  it('starts on loopback with a pairing code, and says why when the port is taken', async () => {
    const b = await startBridge(join(root, 'bridge.json'), { port: 0 });
    if (!('server' in b)) throw new Error(b.error);
    expect(b.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(b.server.pairingCode).toMatch(/\S/);
    const info = await (await fetch(`http://127.0.0.1:${b.port}/`)).json();
    expect(info).toMatchObject({ studio: { connected: false } });
    // The port in use: an error to show, not a crash.
    const taken = createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', () => r()));
    const port = (taken.address() as { port: number }).port;
    const again = await startBridge(join(root, 'bridge2.json'), { port });
    expect(again).toMatchObject({ error: expect.stringMatching(/could not start/) });
    taken.close();
    await b.server.close();
  });
});
