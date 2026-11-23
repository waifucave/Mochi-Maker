/**
 * The release: the gate the Desktop workflow runs before publishing (release-check.mjs), and the
 * release notes, which must name the zips the workflow makes and use the README's own words
 * about what is switched off.
 */
import { readFileSync } from 'node:fs';
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

  it('runs in the workflow before the builds and again before publishing', () => {
    const wf = read('.github/workflows/desktop.yml');
    expect(wf).toMatch(/check:\n[\s\S]*?node packages\/desktop\/release-check\.mjs "\$TAG"/);
    expect(wf).toMatch(/package:\n\s+needs: check/);
    const release = wf.slice(wf.indexOf('  release:'));
    expect(release).toMatch(/needs: \[check, package\]/);
    expect(release.indexOf('release-check.mjs')).toBeLessThan(release.indexOf('gh release create'));
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
