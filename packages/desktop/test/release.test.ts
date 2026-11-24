/**
 * The release: the gate the Desktop workflow runs before building and before the release is
 * created (release-check.mjs), the release job's steps, and the
 * release notes, which must name the zips the workflow makes and use the README's own words
 * about what is switched off.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseProblems } from '../release-check.mjs';

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
      expect.stringMatching(/started on the branch main, not on refs\/heads\/feature/),
    ]);
    expect(releaseProblems({ ...main, ref: 'refs/tags/v0.1.0' })).toEqual([
      expect.stringMatching(/branch main/),
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
    expect(wf).toMatch(/package:\n\s+needs: check/);
    const release = wf.slice(wf.indexOf('  release:\n    needs'));
    expect(release).toMatch(/needs: \[check, package\]/);
    expect(release).toMatch(
      /if: startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.release\)/,
    );
    // The gate, then a draft, its files checked, then published.
    const order = [
      'release-check.mjs --github',
      'gh release create',
      'gh release download',
      '--draft=false',
    ];
    const at = order.map((x) => release.indexOf(x));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The two starts differ only in where the draft points: an existing tag, or the run's commit.
    expect(release).toMatch(/--draft --prerelease "\$\{where\[@\]\}"/);
    expect(release).toMatch(/where=\(--verify-tag\); else where=\(--target "\$GITHUB_SHA"\)/);
    // A failure leaves no draft, and no release or tag this run published.
    expect(release).toMatch(/if: failure\(\)[\s\S]*--cleanup-tag/);
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

describe('the gate in the workflow (--github), against a stand-in for GitHub’s API', () => {
  /** Runs the gate as the workflow does, with what the stand-in says exists. */
  async function gate(
    env: Record<string, string>,
    state: { tag: boolean; releases: { tag_name: string; draft: boolean }[] },
  ) {
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
      if (req.url?.startsWith('/repos/o/r/git/ref/tags/')) {
        const ref = `refs/tags/${decodeURIComponent(req.url.split('/tags/')[1]!)}`;
        res.writeHead(state.tag ? 200 : 404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(state.tag ? { ref } : { message: 'Not Found' }));
      }
      if (req.url?.startsWith('/repos/o/r/releases')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(state.releases));
      }
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const out = join(mkdtempSync(join(tmpdir(), 'gate-')), 'output');
    writeFileSync(out, '');
    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
      execFile(
        process.execPath,
        [join(ROOT, 'packages/desktop/release-check.mjs'), '--github'],
        {
          env: {
            PATH: process.env.PATH,
            GITHUB_API_URL: `http://127.0.0.1:${port}`,
            GITHUB_REPOSITORY: 'o/r',
            GH_TOKEN: 'token-123',
            GITHUB_OUTPUT: out,
            ...env,
          },
        },
        (e, stdout, stderr) => resolve({ code: e ? (e.code as number) : 0, stdout, stderr }),
      ),
    );
    server.close();
    return { ...r, output: readFileSync(out, 'utf8'), seen };
  }
  const byHand = {
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main',
    RELEASE: 'true',
  };

  it('lets a release by hand go ahead when nothing exists, and says how it starts', async () => {
    const r = await gate(byHand, { tag: false, releases: [{ tag_name: 'v0.0.9', draft: false }] });
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
    expect(other.stderr).toMatch(/must be started on the branch main, not on refs\/heads\/next/);
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
});

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
