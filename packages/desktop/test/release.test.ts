/**
 * The release: the gate the Desktop workflow runs before building and before the release is
 * created (release-check.mjs), the release job's steps (release.mjs), run against a stand-in for
 * GitHub's API, and the release notes, which must name the zips the workflow makes and use the
 * README's own words about what is switched off.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseProblems, startOf } from '../release-check.mjs';
import { cleanupPlan, RELEASE_FILES, steps, tagProblems } from '../release.mjs';
import { fakeGitHub, type FakeHooks, type FakeRelease, type FakeState } from './fake-github.js';

/**
 * The limit for the tests here that start the gate as its own process, as the workflow does (one
 * to five times a test): the longest took 0.89 s on two busy cores.
 */
const PROCESS = 30_000;

const ROOT = join(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const CHANGELOG = '# Changelog\n\n## 0.1.0\n\nThe first release.\n';

describe('the release gate', () => {
  it('passes a tag that is v plus the version, with a changelog section', () => {
    expect(releaseProblems({ version: '0.1.0', changelog: CHANGELOG, tag: 'v0.1.0' })).toEqual([]);
    // Run by hand, without a tag: only the changelog is checked.
    expect(releaseProblems({ version: '0.1.0', changelog: CHANGELOG, tag: undefined })).toEqual([]);
  });

  it('fails any other tag, and a version without a section', () => {
    for (const tag of ['v0.1.1', '0.1.0', 'v0.1', 'v0.1.0-rc.1', 'release'])
      expect(releaseProblems({ version: '0.1.0', changelog: CHANGELOG, tag }), tag).toEqual([
        expect.stringMatching(/the tag must be v0\.1\.0/),
      ]);
    expect(releaseProblems({ version: '0.2.0', changelog: CHANGELOG, tag: 'v0.2.0' })).toEqual([
      expect.stringMatching(/CHANGELOG\.md has no section for 0\.2\.0/),
    ]);
    // A heading that only starts with the version is not its section.
    expect(
      releaseProblems({ version: '0.1.0', changelog: '## 0.1.0-rc.1\n', tag: 'v0.1.0' }),
    ).toEqual([expect.stringMatching(/no section for 0\.1\.0/)]);
  });

  it('lets a release by hand go ahead only on main, before the tag and the release exist', () => {
    const base = { version: '0.1.0', changelog: CHANGELOG, start: 'dispatch' as const };
    const main = { ...base, ref: 'refs/heads/main', tagExists: false, releases: [] };
    expect(releaseProblems(main)).toEqual([]);
    expect(releaseProblems({ ...main, ref: 'refs/heads/feature' })).toEqual([
      expect.stringMatching(/A release by hand is made from main, not from refs\/heads\/feature/),
    ]);
    expect(releaseProblems({ ...main, ref: 'refs/tags/v0.1.0' })).toEqual([
      expect.stringMatching(/A release by hand is made from main, not from refs\/tags\/v0\.1\.0/),
    ]);
    expect(releaseProblems({ ...main, tagExists: true })).toEqual([
      expect.stringMatching(/The tag v0\.1\.0 exists already/),
    ]);
    expect(releaseProblems({ ...main, tagExists: true, releases: [{ draft: false }] })).toEqual([
      expect.stringMatching(/tag v0\.1\.0 exists already/),
      expect.stringMatching(/The release v0\.1\.0 exists already\. Nothing is built\./),
    ]);
    expect(releaseProblems({ ...main, releases: [{ draft: true }] })).toEqual([
      expect.stringMatching(/A draft release for v0\.1\.0 exists already/),
    ]);
  });

  it('lets a pushed tag go ahead only when no release exists for it', () => {
    const tag = {
      version: '0.1.0',
      changelog: CHANGELOG,
      start: 'tag' as const,
      tag: 'v0.1.0',
      ref: 'refs/tags/v0.1.0',
      tagExists: true,
      releases: [],
    };
    expect(releaseProblems(tag)).toEqual([]);
    expect(releaseProblems({ ...tag, releases: [{ draft: false }] })).toEqual([
      expect.stringMatching(/The release v0\.1\.0 exists already/),
    ]);
    expect(releaseProblems({ ...tag, tag: 'v0.1.1' })).toEqual([
      expect.stringMatching(/the tag must be v0\.1\.0/),
    ]);
  });

  it('runs in the workflow before the builds and again before the release is created', () => {
    const wf = read('.github/workflows/desktop.yml');
    expect(wf).toMatch(/release:\n\s+description: .*\n\s+type: boolean\n\s+default: false/);
    expect(wf).toMatch(/check:\n[\s\S]*?node packages\/desktop\/release-check\.mjs --github/);
    // The gate's start decides the rest of the run: the macOS x64 build and the release job.
    expect(wf).toMatch(/outputs:\n\s+start: \$\{\{ steps\.gate\.outputs\.start \}\}/);
    expect(wf).toMatch(/package:\n\s+needs: check/);
    expect(wf).toMatch(
      /fromJSON\(\(needs\.check\.outputs\.start != 'none' \|\| inputs\.macos_x64\)/,
    );
    const release = wf.slice(wf.indexOf('  release:\n    needs'));
    expect(release).toMatch(/needs: \[check, package\]/);
    expect(release).toMatch(
      /if: >-\n\s+needs\.check\.outputs\.start == 'tag' \|\| needs\.check\.outputs\.start == 'dispatch' \|\|\n\s+needs\.check\.outputs\.start == 'rehearsal'/,
    );
    // A rehearsal: its own box, passed to both gates, and its last step after verify.
    expect(wf).toMatch(/rehearsal:\n\s+description: .*\n\s+type: boolean\n\s+default: false/);
    expect(wf.match(/REHEARSAL: \$\{\{ inputs\.rehearsal \}\}/g)?.length).toBe(2);
    expect(release.indexOf('release.mjs remove')).toBeGreaterThan(
      release.indexOf('release.mjs verify'),
    );
    expect(release).toMatch(
      /if: steps\.gate\.outputs\.start == 'rehearsal'\n[\s\S]*?release\.mjs remove/,
    );
    expect(wf).not.toMatch(/startsWith\(github\.ref/);
    // A run without a release downloads the artifacts as the release job does, and checks them.
    const download = (job: string) => {
      const at = wf.indexOf(`  ${job}:\n    needs`);
      return wf.slice(at, wf.indexOf('merge-multiple: true', at));
    };
    expect(download('artifacts')).toMatch(/if: needs\.check\.outputs\.start == 'none'/);
    expect(download('artifacts').slice(download('artifacts').indexOf('uses:'))).toBe(
      download('release').slice(download('release').indexOf('uses: actions/download')),
    );
    // The gate, then a draft, its files checked, the tag read again and published, then checked.
    const order = [
      'release-check.mjs --github',
      'release.mjs draft',
      'release.mjs files',
      'release.mjs publish',
      'release.mjs verify',
    ];
    const at = order.map((x) => release.indexOf(x));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // A failure: only release.mjs's cleanup deletes, and nothing else in the workflow does.
    expect(release).toMatch(/if: failure\(\)[\s\S]*release\.mjs cleanup/);
    expect(wf).not.toMatch(/gh release (delete|create|edit)|--cleanup-tag|-X DELETE/);
  });

  it('uses the current major version of each action, in every workflow', () => {
    const current: Record<string, string> = {
      'actions/checkout': 'v7',
      'actions/setup-node': 'v7',
      'actions/upload-artifact': 'v7',
      'actions/download-artifact': 'v8',
    };
    for (const f of ['ci.yml', 'desktop.yml']) {
      const uses = [...read(`.github/workflows/${f}`).matchAll(/uses: ([\w-]+\/[\w-]+)@(\S+)/g)];
      expect(uses.length, f).toBeGreaterThan(0);
      for (const [, action, version] of uses)
        expect(`${action}@${version}`, f).toBe(`${action}@${current[action!]}`);
    }
  });

  it('starts no second run: only a pushed tag and a run by hand start the workflow', () => {
    // A tag created by the run's own token starts no workflow; and nothing listens for a
    // release being published.
    for (const f of ['ci.yml', 'desktop.yml']) {
      const wf = read(`.github/workflows/${f}`);
      expect(wf, f).not.toMatch(/^\s+release:\n\s+types:/m);
      expect(wf, f).not.toMatch(/workflow_run:/);
    }
    expect(read('.github/workflows/ci.yml')).toMatch(/push:\n\s+branches: \[main\]/);
  });
});

describe(
  'the gate in the workflow (--github), against a stand-in for GitHub’s API',
  { timeout: PROCESS },
  () => {
    /** Runs the gate as the workflow does, with what the stand-in says exists. */
    async function gate(
      env: Record<string, string>,
      state: { tag: boolean; releases: { tag_name: string; draft: boolean }[] },
    ) {
      const fake = await fakeGitHub({
        tags: state.tag ? { 'v0.1.0': 'c'.repeat(40) } : {},
        releases: state.releases.map((r, k) => ({
          ...release(r.tag_name),
          id: k + 1,
          draft: r.draft,
        })),
      });
      const out = join(mkdtempSync(join(tmpdir(), 'gate-')), 'output');
      writeFileSync(out, '');
      const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        execFile(
          process.execPath,
          [join(ROOT, 'packages/desktop/release-check.mjs'), '--github'],
          { env: { PATH: process.env.PATH, ...fake.env, GITHUB_OUTPUT: out, ...env } },
          (e, stdout, stderr) => resolve({ code: e ? (e.code as number) : 0, stdout, stderr }),
        ),
      );
      await fake.close();
      const seen = fake.seen.map((x) => `${x.method} ${x.url} ${x.authorization ?? ''}`);
      return { ...r, output: readFileSync(out, 'utf8'), seen };
    }
    const byHand = {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      RELEASE: 'true',
    };

    it('lets a release by hand go ahead when nothing exists, and says how it starts', async () => {
      const r = await gate(byHand, {
        tag: false,
        releases: [{ tag_name: 'v0.0.9', draft: false }],
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('0.1.0 (release: by dispatch)\n');
      expect(r.output).toBe('version=0.1.0\ntag=v0.1.0\nstart=dispatch\n');
      expect(r.seen).toEqual([
        'GET /repos/o/r/git/ref/tags/v0.1.0 Bearer token-123',
        'GET /repos/o/r/releases?per_page=100&page=1 Bearer token-123',
      ]);
    });

    it('stops a second release by hand: the tag and the release exist', async () => {
      const r = await gate(byHand, { tag: true, releases: [{ tag_name: 'v0.1.0', draft: false }] });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/The tag v0\.1\.0 exists already/);
      expect(r.stderr).toMatch(/The release v0\.1\.0 exists already\. Nothing is built\./);
      expect(r.output).toBe('');
    });

    it('stops on a leftover draft, and on another branch', async () => {
      const draft = await gate(byHand, {
        tag: false,
        releases: [{ tag_name: 'v0.1.0', draft: true }],
      });
      expect(draft.stderr).toMatch(/A draft release for v0\.1\.0 exists already/);
      const other = await gate(
        { ...byHand, GITHUB_REF: 'refs/heads/next', GITHUB_REF_NAME: 'next' },
        { tag: false, releases: [] },
      );
      expect(other.stderr).toMatch(
        /A release by hand is made from main, not from refs\/heads\/next/,
      );
    });

    it('lets a pushed tag go ahead, and a run by hand without «release» only checks', async () => {
      const tag = await gate(
        { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.1.0', GITHUB_REF_NAME: 'v0.1.0' },
        { tag: true, releases: [] },
      );
      expect([tag.code, tag.output]).toEqual([0, 'version=0.1.0\ntag=v0.1.0\nstart=tag\n']);
      const plain = await gate({ ...byHand, RELEASE: 'false' }, { tag: true, releases: [] });
      expect([plain.code, plain.stdout, plain.seen]).toEqual([0, '0.1.0 (release: no)\n', []]);
    });
  },
);

describe('a release by a tag means a tag was pushed', { timeout: PROCESS }, () => {
  const tagRef = { GITHUB_REF: 'refs/tags/v0.1.0', GITHUB_REF_NAME: 'v0.1.0' };

  it('starts by tag only on a push; a run by hand from a tag ref is by hand', () => {
    expect(startOf({ ...tagRef, GITHUB_EVENT_NAME: 'push' })).toBe('tag');
    expect(startOf({ ...tagRef, GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE: 'false' })).toBe(
      undefined,
    );
    expect(startOf({ ...tagRef, GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE: 'true' })).toBe(
      'dispatch',
    );
    expect(startOf({ ...tagRef, GITHUB_EVENT_NAME: 'workflow_dispatch' })).toBe(undefined);
  });

  it('a run by hand from a tag ref makes nothing without «release», and is refused with it', async () => {
    const run = async (release: string) => {
      const fake = await fakeGitHub({ tags: { 'v0.1.0': 'c'.repeat(40) } });
      const out = join(mkdtempSync(join(tmpdir(), 'gate-')), 'output');
      writeFileSync(out, '');
      const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        execFile(
          process.execPath,
          [join(ROOT, 'packages/desktop/release-check.mjs'), '--github'],
          {
            env: {
              PATH: process.env.PATH,
              ...fake.env,
              GITHUB_OUTPUT: out,
              ...tagRef,
              GITHUB_EVENT_NAME: 'workflow_dispatch',
              RELEASE: release,
            },
          },
          (e, stdout, stderr) => resolve({ code: e ? (e.code as number) : 0, stdout, stderr }),
        ),
      );
      await fake.close();
      return { ...r, output: readFileSync(out, 'utf8'), requests: fake.seen.length };
    };
    const off = await run('false');
    expect([off.code, off.stdout, off.requests]).toEqual([0, '0.1.0 (release: no)\n', 0]);
    // start=none: the workflow then skips the release job and builds no macOS x64 app.
    expect(off.output).toBe('version=0.1.0\ntag=v0.1.0\nstart=none\n');
    const on = await run('true');
    expect(on.code).toBe(1);
    expect(on.stderr).toMatch(
      /A release by hand is made from main, not from refs\/tags\/v0\.1\.0\./,
    );
    expect(on.output).toBe('');
  });
});

/** A release as the stand-in keeps it. */
function release(tag_name: string): FakeRelease {
  return {
    id: 1,
    tag_name,
    target_commitish: 'main',
    name: tag_name,
    body: '',
    draft: false,
    prerelease: false,
    assets: [],
  };
}

describe('the release steps (release.mjs), against a stand-in for GitHub', () => {
  const SHA = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const OLD = { ...release('v0.0.9'), id: 7 };

  function dist() {
    const dir = mkdtempSync(join(tmpdir(), 'dist-'));
    for (const name of RELEASE_FILES)
      writeFileSync(join(dir, name), `the zip ${name}\n`.repeat(50));
    return dir;
  }

  /**
   * Runs the release job's steps as the workflow does: draft, files, publish, verify, and the
   * cleanup when one fails. `between` runs before publish (a person pushing a tag meanwhile).
   */
  async function releaseJob(
    start: 'tag' | 'dispatch',
    init: Partial<FakeState>,
    { hooks, between }: { hooks?: FakeHooks; between?: (s: FakeState) => void } = {},
  ) {
    const fake = await fakeGitHub(
      { ...init, releases: [{ ...OLD }, ...(init.releases ?? [])] },
      hooks,
    );
    const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'output');
    writeFileSync(out, '');
    const env: Record<string, string> = {
      ...fake.env,
      TAG: 'v0.1.0',
      VERSION: '0.1.0',
      START: start,
      GITHUB_SHA: SHA,
      DIST: dist(),
      GITHUB_OUTPUT: out,
      VERIFY_WAIT_MS: '1',
    };
    const log: string[] = [];
    let failed: { step: string; message: string } | undefined;
    for (const step of ['draft', 'files', 'publish', 'verify'] as const) {
      if (step === 'publish') between?.(fake.state);
      const id = readFileSync(out, 'utf8').match(/^id=(\d+)$/m)?.[1];
      try {
        await steps[step]({ ...env, ...(id ? { RELEASE_ID: id } : {}) }, (l) => log.push(l));
      } catch (e) {
        failed = { step, message: (e as Error).message };
        await steps.cleanup({ ...env, ...(id ? { RELEASE_ID: id } : {}) }, (l) => log.push(l));
        break;
      }
    }
    await fake.close();
    return { failed, log, state: fake.state, seen: fake.seen };
  }
  const left = (state: FakeState) =>
    state.releases.map((r) => `${r.tag_name} ${r.draft ? 'draft' : 'published'}`);

  it('a release by hand: the draft, its files, then published, with the tag at the run’s commit', async () => {
    const r = await releaseJob('dispatch', {});
    expect(r.failed).toBe(undefined);
    expect(r.state.tags).toEqual({ 'v0.1.0': SHA });
    const made = r.state.releases.find((x) => x.tag_name === 'v0.1.0')!;
    expect(made).toMatchObject({
      name: 'Mochi Maker 0.1.0',
      target_commitish: SHA,
      draft: false,
      prerelease: true,
    });
    expect(made.body).toBe(
      read('packages/desktop/release-notes.md').replaceAll('{{version}}', '0.1.0'),
    );
    expect(made.assets.map((a) => a.name)).toEqual(RELEASE_FILES);
    expect(made.assets.map((a) => a.data.toString())).toEqual(
      RELEASE_FILES.map((n) => `the zip ${n}\n`.repeat(50)),
    );
    // Each upload states its length (GitHub refuses a chunked upload); the stored files are
    // fetched from the redirect without the token.
    const uploads = r.seen.filter((x) => x.url.startsWith('/uploads/'));
    expect(uploads.map((x) => [x.contentLength, x.transferEncoding])).toEqual(
      RELEASE_FILES.map((n) => [String(`the zip ${n}\n`.repeat(50).length), undefined]),
    );
    const storage = r.seen.filter((x) => x.url.startsWith('/storage/'));
    expect(storage.length).toBe(4);
    expect(storage.every((x) => x.authorization === undefined)).toBe(true);
    expect(r.log.filter((l) => /^[0-9a-f]{64}  /.test(l)).length).toBe(4);
    expect(left(r.state)).toEqual(['v0.0.9 published', 'v0.1.0 published']);
  });

  it('a pushed tag: the same steps, and the tag stays as it was pushed', async () => {
    const r = await releaseJob('tag', { tags: { 'v0.1.0': SHA } });
    expect(r.failed).toBe(undefined);
    expect(r.state.tags).toEqual({ 'v0.1.0': SHA });
    expect(left(r.state)).toEqual(['v0.0.9 published', 'v0.1.0 published']);
    // The two starts make the same calls.
    const calls = (s: typeof r.seen) => s.map((x) => `${x.method} ${x.url.replace(/\d{4}/g, 'N')}`);
    expect(calls(r.seen)).toEqual(calls((await releaseJob('dispatch', {})).seen));
  });

  it('a pushed tag that is not at the run’s commit: nothing is created', async () => {
    const r = await releaseJob('tag', { tags: { 'v0.1.0': OTHER } });
    expect(r.failed).toMatchObject({
      step: 'draft',
      message: expect.stringMatching(/points at b{40}, not at this run's commit/),
    });
    expect(left(r.state)).toEqual(['v0.0.9 published']);
    expect(r.state.tags).toEqual({ 'v0.1.0': OTHER });
  });

  it('by hand, a tag pushed by a person after the gate: not published, and the tag is kept', async () => {
    // The case: the gate passed; before publishing, someone pushes v0.1.0 at another commit.
    const r = await releaseJob('dispatch', {}, { between: (s) => (s.tags['v0.1.0'] = OTHER) });
    expect(r.failed).toMatchObject({
      step: 'publish',
      message: expect.stringMatching(/The tag v0\.1\.0 appeared after the gate, at b{40}/),
    });
    // Only the draft this run made is deleted; the person's tag stays where it was pushed.
    expect(left(r.state)).toEqual(['v0.0.9 published']);
    expect(r.state.tags).toEqual({ 'v0.1.0': OTHER });
    expect(r.log).toContain(`kept the tag v0.1.0 (at ${OTHER})`);
    expect(r.seen.some((x) => x.method === 'DELETE' && x.url.includes('/git/refs/'))).toBe(false);
  });

  it('by hand, a tag pushed in the very moment of publishing: published, and nothing is deleted', async () => {
    // Too late for the read before publishing: the publish attaches to the person's tag. The
    // last check finds it, the job fails "Published, but …", and the run deletes nothing.
    const r = await releaseJob(
      'dispatch',
      {},
      { hooks: { beforePatch: (s) => (s.tags['v0.1.0'] = OTHER) } },
    );
    expect(r.failed).toMatchObject({
      step: 'verify',
      message: expect.stringMatching(
        /^Published, but the tag v0\.1\.0 is at b{40}, not at this run's commit a{40}\.$/,
      ),
    });
    expect(left(r.state)).toEqual(['v0.0.9 published', 'v0.1.0 published']);
    expect(r.state.tags).toEqual({ 'v0.1.0': OTHER });
    expect(r.seen.filter((x) => x.method === 'DELETE')).toEqual([]);
    expect(r.log.filter((l) => /^check \d of 5: /.test(l)).length).toBe(5);
  });

  it('after publishing, a check that keeps failing deletes nothing, by hand or on a pushed tag', async () => {
    for (const start of ['dispatch', 'tag'] as const) {
      const r = await releaseJob(start, start === 'tag' ? { tags: { 'v0.1.0': SHA } } : {}, {
        hooks: {
          afterPatch: (_s, rel) => {
            rel.prerelease = false;
            rel.assets.find((a) => a.name === 'mochi-maker-linux-x64.zip')!.data = Buffer.from('x');
            rel.assets = rel.assets.filter((a) => a.name !== 'mochi-maker-win32-x64.zip');
          },
        },
      });
      // It says exactly what differs.
      expect(r.failed?.step, start).toBe('verify');
      expect(r.failed?.message, start).toBe(
        'Published, but the release is not marked as a pre-release; ' +
          'mochi-maker-win32-x64.zip is missing; mochi-maker-linux-x64.zip has 1 bytes, not ' +
          `${'the zip mochi-maker-linux-x64.zip\n'.repeat(50).length}.`,
      );
      expect(left(r.state), start).toEqual(['v0.0.9 published', 'v0.1.0 published']);
      expect(r.state.tags, start).toEqual({ 'v0.1.0': SHA });
      expect(
        r.seen.filter((x) => x.method === 'DELETE'),
        start,
      ).toEqual([]);
      expect(r.log, start).toContain(
        `kept the published release ${r.state.releases[1]!.id}: once published, a release is never deleted by the run; a person decides`,
      );
    }
  });

  it('after publishing, a file with another digest is named', async () => {
    const r = await releaseJob(
      'dispatch',
      {},
      {
        hooks: {
          afterPatch: (_s, rel) => {
            const a = rel.assets.find((x) => x.name === 'mochi-maker-darwin-x64.zip')!;
            a.data = Buffer.from(a.data.toString().replace('the', 'THE'));
          },
        },
      },
    );
    expect(r.failed?.message).toMatch(
      /^Published, but mochi-maker-darwin-x64\.zip has the digest sha256:[0-9a-f]{64}, not the built sha256:[0-9a-f]{64}\.$/,
    );
    expect(left(r.state)).toEqual(['v0.0.9 published', 'v0.1.0 published']);
  });

  it('verify reads again: a read that fails twice, then succeeds, passes', async () => {
    const r = await releaseJob(
      'dispatch',
      {},
      {
        hooks: {
          answer: (method, path, n) =>
            method === 'GET' && path === '/repos/o/r/git/ref/tags/v0.1.0' && n >= 3 && n <= 4
              ? 'fail'
              : undefined,
        },
      },
    );
    // The draft's and the publish's tag reads are the first two; verify's first two fail.
    expect(r.failed).toBe(undefined);
    expect(
      r.log.filter((l) => /^check [12] of 5: a read failed \(GitHub GET .* 503/.test(l)).length,
    ).toBe(2);
    expect(left(r.state)).toEqual(['v0.0.9 published', 'v0.1.0 published']);
  });

  it('a publish whose answer is lost: the release is read again, and the call is not sent twice', async () => {
    const r = await releaseJob(
      'dispatch',
      {},
      {
        hooks: { answer: (method, path) => (method === 'PATCH' ? 'drop' : undefined) },
      },
    );
    expect(r.failed).toBe(undefined);
    expect(r.seen.filter((x) => x.method === 'PATCH').length).toBe(1);
    expect(r.log).toContain('published v0.1.0 (the call took effect; its answer was lost)');
    expect(left(r.state)).toEqual(['v0.0.9 published', 'v0.1.0 published']);
    expect(r.state.tags).toEqual({ 'v0.1.0': SHA });
  });

  it('a publish that failed without taking effect is sent again, once the release reads as a draft', async () => {
    const r = await releaseJob(
      'dispatch',
      {},
      {
        hooks: { answer: (method, _p, n) => (method === 'PATCH' && n === 1 ? 'fail' : undefined) },
      },
    );
    expect(r.failed).toBe(undefined);
    expect(r.seen.filter((x) => x.method === 'PATCH').length).toBe(2);
    expect(r.log).toContain('still a draft: sending the publishing call again');
    expect(r.log).toContain('published v0.1.0');
  });

  it('a write that gets a 404 is an error where it happens', async () => {
    const fake = await fakeGitHub();
    const log: string[] = [];
    const env = {
      ...fake.env,
      TAG: 'v0.1.0',
      START: 'dispatch',
      GITHUB_SHA: SHA,
      RELEASE_ID: '999',
    };
    await expect(steps.publish(env, (l) => log.push(l))).rejects.toThrow(
      /PATCH \/releases\/999: 404/,
    );
    await fake.close();
    expect(log).toEqual([]);
  });

  it('a file that comes back different: not published, the draft deleted', async () => {
    const r = await releaseJob('dispatch', {}, { hooks: { corrupt: 'mochi-maker-linux-x64.zip' } });
    expect(r.failed).toMatchObject({
      step: 'files',
      message: expect.stringMatching(
        /mochi-maker-linux-x64\.zip in the draft is [0-9a-f]{64}, not the built/,
      ),
    });
    expect(left(r.state)).toEqual(['v0.0.9 published']);
    expect(r.state.tags).toEqual({});
  });

  it('the cleanup touches nothing it did not make', async () => {
    // Someone else's draft for the same tag, and no release made by this run (no id).
    const theirs = { ...release('v0.1.0'), id: 55, draft: true };
    const fake = await fakeGitHub({ tags: { 'v0.1.0': SHA }, releases: [{ ...OLD }, theirs] });
    const log: string[] = [];
    const env = { ...fake.env, TAG: 'v0.1.0', START: 'dispatch', GITHUB_SHA: SHA };
    await steps.cleanup(env, (l) => log.push(l));
    expect(log).toEqual(['nothing to clean: this run created no release']);
    // With an id that is not there any more: no release to delete, and the tag is not this run's.
    await steps.cleanup({ ...env, RELEASE_ID: '999' }, (l) => log.push(l));
    await fake.close();
    expect(left(fake.state)).toEqual(['v0.0.9 published', 'v0.1.0 draft']);
    expect(fake.state.tags).toEqual({ 'v0.1.0': SHA });
    expect(fake.seen.filter((x) => x.method === 'DELETE')).toEqual([]);
  });

  it('the draft needs exactly the four zips', async () => {
    const fake = await fakeGitHub();
    const dir = dist();
    writeFileSync(join(dir, 'extra.zip'), 'x');
    const env = {
      ...fake.env,
      TAG: 'v0.1.0',
      VERSION: '0.1.0',
      START: 'dispatch',
      GITHUB_SHA: SHA,
      DIST: dir,
    };
    await expect(steps.draft(env, () => {})).rejects.toThrow(
      /exactly the four zips: unexpected extra\.zip/,
    );
    await fake.close();
    expect(fake.state.releases).toEqual([]);
  });

  it('the rules, as tables', () => {
    const t = { tag: 'v0.1.0', sha: SHA };
    expect(tagProblems({ ...t, start: 'tag', tagSha: SHA })).toEqual([]);
    expect(tagProblems({ ...t, start: 'tag', tagSha: null })).toEqual([
      expect.stringMatching(/is gone/),
    ]);
    expect(tagProblems({ ...t, start: 'dispatch', tagSha: null })).toEqual([]);
    expect(tagProblems({ ...t, start: 'dispatch', tagSha: SHA })).toEqual([
      expect.stringMatching(/appeared after the gate/),
    ]);
    expect(tagProblems({ ...t, start: undefined, tagSha: null })).toEqual([
      expect.stringMatching(/makes no release/),
    ]);
    const plan = (start: string, release: { draft: boolean } | null, tagSha: string | null) =>
      cleanupPlan({
        start,
        tag: 'v0.1.0',
        sha: SHA,
        release: release && { ...release, tag_name: 'v0.1.0' },
        tagSha,
      });
    // A draft is deleted; a published release, and its tag, never.
    expect(plan('dispatch', { draft: true }, null)).toEqual({ release: true, tag: false });
    expect(plan('dispatch', { draft: false }, SHA)).toEqual({ release: false, tag: false });
    expect(plan('dispatch', { draft: false }, OTHER)).toEqual({ release: false, tag: false });
    expect(plan('dispatch', { draft: true }, SHA)).toEqual({ release: true, tag: false });
    expect(plan('dispatch', null, SHA)).toEqual({ release: false, tag: false });
    expect(plan('tag', { draft: true }, SHA)).toEqual({ release: true, tag: false });
    expect(plan('tag', { draft: false }, SHA)).toEqual({ release: false, tag: false });
    // A release that does not carry this run's tag is never this run's.
    expect(
      cleanupPlan({
        start: 'dispatch',
        tag: 'v0.1.0',
        sha: SHA,
        release: { draft: false, tag_name: 'v0.0.9' },
        tagSha: SHA,
      }),
    ).toEqual({ release: false, tag: false });
    // A rehearsal: like a run by hand, for its own tag only.
    const r12 = { draft: false, tag_name: 'rehearsal-12' };
    expect(
      cleanupPlan({ start: 'rehearsal', tag: 'rehearsal-12', sha: SHA, release: r12, tagSha: SHA }),
    ).toEqual({
      release: true,
      tag: true,
    });
    expect(
      cleanupPlan({
        start: 'rehearsal',
        tag: 'v0.1.0',
        sha: SHA,
        release: { draft: false, tag_name: 'v0.1.0' },
        tagSha: SHA,
      }),
    ).toEqual({ release: false, tag: false });
    expect(
      tagProblems({ start: 'rehearsal', tag: 'rehearsal-12', tagSha: null, sha: SHA }),
    ).toEqual([]);
    expect(tagProblems({ start: 'rehearsal', tag: 'v0.1.0', tagSha: null, sha: SHA })).toEqual([
      expect.stringMatching(/only a tag rehearsal-<run number>, never v0\.1\.0/),
    ]);
  });
});

describe(
  'a rehearsal: the release path with a throwaway tag, removed again',
  { timeout: PROCESS },
  () => {
    const SHA = 'a'.repeat(40);
    const REAL_SHA = 'd'.repeat(40);
    /** The real release, as round after round leaves it: it must stay exactly so. */
    const real = (): FakeRelease => ({
      ...release('v0.1.0'),
      id: 9,
      name: 'Mochi Maker 0.1.0',
      target_commitish: REAL_SHA,
      prerelease: true,
      assets: [{ id: 91, name: 'mochi-maker-linux-x64.zip', size: 3, data: Buffer.from('zip') }],
    });
    const withReal = () => ({ tags: { 'v0.1.0': REAL_SHA }, releases: [real()] });
    const byHand = {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REF_NAME: 'main',
      GITHUB_RUN_NUMBER: '12',
      REHEARSAL: 'true',
      RELEASE: 'false',
    };

    async function gate(env: Record<string, string>, init: Partial<FakeState>) {
      const fake = await fakeGitHub(init);
      const out = join(mkdtempSync(join(tmpdir(), 'gate-')), 'output');
      writeFileSync(out, '');
      const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
        execFile(
          process.execPath,
          [join(ROOT, 'packages/desktop/release-check.mjs'), '--github'],
          { env: { PATH: process.env.PATH, ...fake.env, GITHUB_OUTPUT: out, ...env } },
          (e, stdout, stderr) => resolve({ code: e ? (e.code as number) : 0, stdout, stderr }),
        ),
      );
      await fake.close();
      return {
        ...r,
        output: readFileSync(out, 'utf8'),
        seen: fake.seen.map((x) => `${x.method} ${x.url}`),
      };
    }

    it('the gate lets it go ahead in a private repository, past the real release, and looks only at its tag', async () => {
      const r = await gate(byHand, withReal());
      expect([r.code, r.stdout]).toEqual([0, '0.1.0 (release: a rehearsal, rehearsal-12)\n']);
      expect(r.output).toBe('version=0.1.0\ntag=rehearsal-12\nstart=rehearsal\n');
      expect(r.seen).toEqual([
        'GET /repos/o/r',
        'GET /repos/o/r/git/ref/tags/rehearsal-12',
        'GET /repos/o/r/releases?per_page=100&page=1',
      ]);
    });

    it('the gate refuses it in a public repository, with «release», and over a leftover', async () => {
      const pub = await gate(byHand, { ...withReal(), private: false });
      expect([pub.code, pub.output]).toEqual([1, '']);
      expect(pub.stderr).toMatch(/A rehearsal is made only in a private repository/);
      const both = await gate({ ...byHand, RELEASE: 'true' }, withReal());
      expect(both.stderr).toMatch(/«rehearsal» and «release» cannot both be checked/);
      const tag = await gate(byHand, { tags: { 'rehearsal-12': SHA } });
      expect(tag.stderr).toMatch(/The tag rehearsal-12 exists already/);
      const draft = await gate(byHand, { releases: [{ ...release('rehearsal-12'), draft: true }] });
      expect(draft.stderr).toMatch(/A draft release for rehearsal-12 exists already/);
      // On a push of a tag, «rehearsal» does not exist: the start is the tag's.
      expect(
        startOf({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.1.0', REHEARSAL: 'true' }),
      ).toBe('tag');
    });

    /** The release job's steps for a rehearsal, as the workflow runs them. */
    async function rehearse(init: Partial<FakeState>, hooks?: FakeHooks, tag = 'rehearsal-12') {
      const fake = await fakeGitHub(init, hooks);
      const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'output');
      writeFileSync(out, '');
      const dir = mkdtempSync(join(tmpdir(), 'dist-'));
      for (const name of RELEASE_FILES) writeFileSync(join(dir, name), `the zip ${name}\n`);
      const env: Record<string, string> = {
        ...fake.env,
        TAG: tag,
        VERSION: '0.1.0',
        START: 'rehearsal',
        GITHUB_SHA: SHA,
        DIST: dir,
        GITHUB_OUTPUT: out,
        REMOVE_WAIT_MS: '1',
        VERIFY_WAIT_MS: '1',
      };
      const log: string[] = [];
      let failed: { step: string; message: string } | undefined;
      for (const step of ['draft', 'files', 'publish', 'verify', 'remove'] as const) {
        const id = readFileSync(out, 'utf8').match(/^id=(\d+)$/m)?.[1];
        const e2 = { ...env, ...(id ? { RELEASE_ID: id } : {}) };
        try {
          await steps[step](e2, (l) => log.push(l));
        } catch (e) {
          failed = { step, message: (e as Error).message };
          // In the workflow the failure cleanup is its own step: its error fails that step too.
          await steps
            .cleanup(e2, (l) => log.push(l))
            .catch((c: Error) => log.push(`cleanup: ${c.message}`));
          break;
        }
      }
      await fake.close();
      return { failed, log, state: fake.state, seen: fake.seen };
    }

    it('goes the whole way, removes what it made, and leaves the real release as it was', async () => {
      let published: FakeRelease | undefined;
      const r = await rehearse(withReal(), { afterPatch: (_s, rel) => (published = { ...rel }) });
      expect(r.failed).toBe(undefined);
      // As published, before it was removed: a pre-release whose title says REHEARSAL, at the commit.
      expect(published).toMatchObject({
        tag_name: 'rehearsal-12',
        target_commitish: SHA,
        draft: false,
        prerelease: true,
        name: expect.stringMatching(/^REHEARSAL rehearsal-12: Mochi Maker 0\.1\.0/),
      });
      expect(published!.body).toMatch(/^\*\*REHEARSAL\*\* of the release path/);
      // The calls, in order: created, uploaded, files checked, published, verified, deleted.
      const calls = r.seen
        .filter((x) => !(x.method === 'GET' && /\/(git\/ref\/tags|releases\?)/.test(x.url)))
        .map((x) => `${x.method} ${x.url.replace(/\d{4}/g, 'N').replace(/\?name=.*/, '')}`);
      expect(calls).toEqual([
        'POST /repos/o/r/releases',
        ...RELEASE_FILES.map(() => 'POST /uploads/repos/o/r/releases/N/assets'),
        'GET /repos/o/r/releases/N/assets?per_page=100',
        ...RELEASE_FILES.flatMap(() => ['GET /repos/o/r/releases/assets/N', 'GET /storage/N']),
        'PATCH /repos/o/r/releases/N',
        'GET /repos/o/r/releases/N',
        'GET /repos/o/r/releases/N',
        'DELETE /repos/o/r/releases/N',
        'DELETE /repos/o/r/git/refs/tags/rehearsal-12',
      ]);
      expect(r.log).toContain('nothing left of rehearsal-12: no release, no draft, no tag');
      // Exactly what was there before: the real release and its tag, untouched.
      expect(r.state.tags).toEqual({ 'v0.1.0': REAL_SHA });
      expect(r.state.releases).toEqual([real()]);
      expect(r.seen.some((x) => x.url.includes('v0.1.0'))).toBe(false);
    });

    it('never touches the real version, whatever it is given', async () => {
      // Told to rehearse with the real tag: every step refuses, and the cleanup deletes nothing.
      const r = await rehearse(withReal(), {}, 'v0.1.0');
      expect(r.failed).toMatchObject({
        step: 'draft',
        message: expect.stringMatching(/never v0\.1\.0/),
      });
      const fake = await fakeGitHub(withReal());
      const env = { ...fake.env, START: 'rehearsal', GITHUB_SHA: REAL_SHA, REMOVE_WAIT_MS: '1' };
      const log: string[] = [];
      for (const step of ['publish', 'remove'] as const)
        await expect(
          steps[step]({ ...env, TAG: 'v0.1.0', RELEASE_ID: '9' }, (l) => log.push(l)),
        ).rejects.toThrow(/never v0\.1\.0/);
      await steps.cleanup({ ...env, TAG: 'v0.1.0', RELEASE_ID: '9' }, (l) => log.push(l));
      // Its own tag, but the real release's id: the release does not carry its tag, so it stays.
      await steps.cleanup({ ...env, TAG: 'rehearsal-12', RELEASE_ID: '9' }, (l) => log.push(l));
      await fake.close();
      expect(log).toContain('kept the release 9: its tag is v0.1.0, not rehearsal-12');
      expect(fake.seen.filter((x) => x.method !== 'GET')).toEqual([]);
      expect(fake.state.tags).toEqual({ 'v0.1.0': REAL_SHA });
      expect(fake.state.releases).toEqual([real()]);
    });

    it('a rehearsal whose check fails after publishing still removes everything it made', async () => {
      const r = await rehearse(withReal(), { afterPatch: (_s, rel) => (rel.prerelease = false) });
      expect(r.failed).toMatchObject({
        step: 'verify',
        message: 'Published, but the release is not marked as a pre-release.',
      });
      expect(r.log).toContain('nothing left of rehearsal-12: no release, no draft, no tag');
      expect(r.state.tags).toEqual({ 'v0.1.0': REAL_SHA });
      expect(r.state.releases).toEqual([real()]);
    });

    it('fails when it cannot clean up: something of its tag is left', async () => {
      // Another draft for the same tag appears while it runs; the rehearsal deletes only its own,
      // then finds the other left and fails.
      const r = await rehearse(withReal(), {
        afterPatch: (s) => s.releases.push({ ...release('rehearsal-12'), id: 77, draft: true }),
      });
      expect(r.failed).toMatchObject({
        step: 'remove',
        message: expect.stringMatching(/could not clean up: the draft 77 is left/),
      });
      expect(r.log).toContain('cleanup: The rehearsal could not clean up: the draft 77 is left.');
      expect(r.state.releases.map((x) => x.id)).toEqual([9, 77]);
      expect(r.state.tags).toEqual({ 'v0.1.0': REAL_SHA });
    });
  },
);

describe('the release notes', () => {
  const notes = read('packages/desktop/release-notes.md');

  it('name the four zips the workflow makes', () => {
    const wf = read('.github/workflows/desktop.yml');
    expect(wf).toContain('ARCHIVE: mochi-maker-${{ matrix.platform }}-${{ matrix.arch }}.zip');
    const builds = [...wf.matchAll(/"platform":"(\w+)","arch":"(\w+)"/g)].map(
      ([, p, a]) => `mochi-maker-${p}-${a}.zip`,
    );
    const zips = [...new Set(builds)].sort();
    expect(zips).toEqual([
      'mochi-maker-darwin-arm64.zip',
      'mochi-maker-darwin-x64.zip',
      'mochi-maker-linux-x64.zip',
      'mochi-maker-win32-x64.zip',
    ]);
    for (const z of zips) expect(notes, z).toContain(`\`${z}\``);
  });

  it('say it is a first pre-release, unsigned, and where to report a problem', () => {
    expect(notes).toMatch(/\*\*Mochi Maker \{\{version\}\} is a first pre-release\.\*\*/);
    expect(notes).toMatch(/## The apps are not signed/);
    for (const system of ['**Windows:**', '**macOS:**', '**Linux:**'])
      expect(notes).toContain(system);
    expect(notes).toMatch(/## Reporting a problem\n\nOpen an issue/);
  });

  it('use the README’s own words about what is switched off, and only point to the reasons', () => {
    const readme = read('README.md');
    const flags = readme
      .slice(readme.indexOf('Glue and blend-shape authoring are not available'))
      .split('\n\n')[0]!
      .replace(/\s+/g, ' ')
      .replace(/ \(\[`docs\/core\.md`\]\(docs\/core\.md#feature-flags\)\)/, '');
    expect(notes.replace(/\s+/g, ' ')).toContain(flags);
    // The only sentence about patents is the pointer to the README and the docs.
    const sentences = notes
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .filter((x) => /patent/i.test(x));
    expect(sentences).toEqual([
      'See the README\'s "Patents" section and `docs/core.md` (Feature flags).',
    ]);
    expect(notes).not.toMatch(/^> /m);
  });
});
