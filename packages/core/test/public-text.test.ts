/**
 * Public text: every tracked file outside the clean-room folder must read well on its own, since
 * the project is published without that folder. This scans them for references that point into
 * the private development record (process documents and their numbering, research labels, people's
 * roles, private repositories, session links), for wording about legal advice, and for
 * descriptions of the project in relation to other products that it must not use. It also checks
 * that the README carries the trademark footer, the patent notice and «How it was made» word for
 * word.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');

/** What must not appear, and why. */
const PATTERNS: [RegExp, string][] = [
  [/\binbox\b/i, 'a process document'],
  [/\brounds? \d+\b|\bround-\d+\b/i, 'a development round'],
  [/clean-?room\//i, 'a path into the clean-room folder'],
  [/\b(maker|vts|params)-\d{2}\b/, 'a research label'],
  [/\bresearch side\b/i, 'a process role'],
  [/\b(VERIFIED|INFERRED)\b/, 'a research tag'],
  [/\bthe coordinator\b|\bcoordinator['’]s\b/i, 'a process role'],
  [/\bthe owner\b|\bowner['’]s\b/i, 'a process role'],
  [/lively2d/i, 'a private repository'],
  [/claude\.ai\/code|\bsession_[0-9A-Za-z]{10,}/, 'a session link'],
  [/\blegal review\b|\blawyers?\b|\battorneys?\b/i, 'wording about legal advice'],
  [/conventions guide|\bguide \d+(\.\d+)*\b|\bUNKNOWN \d+\b/i, 'the private conventions guide'],
  [
    /\bthe guide['’]s (list|step|names|tenth|second|template|workflow|brush|mesh|ctrl|dope|recording)\b|\b(in|of) the guide\b|\bthe guide (says|does not|gives|lists)\b|\b(beta|confirmed) there\b/i,
    'the private conventions guide',
  ],
  [/\b(this|that|next|last|previous) round\b/i, 'a development round'],
  [/Cubism 5\.1/, 'a product version used as a reference'],
  [/\bclone of\b|\balternative to\b|\bdrop-in replacement\b/i, 'a description to avoid'],
  [
    /\bofficial (runtime|editor|sdk|software|documentation|manual|renderer|viewer|app)\b/i,
    'a description to avoid',
  ],
];

/** Files kept as they are: the clean-room process statement, and this test's own patterns. */
const EXEMPT = new Set([
  'CLEANROOM.md',
  '.prettierignore',
  'packages/core/test/public-text.test.ts',
]);
const BINARY = /\.(png|psd|ora|moc3|tgz|wav|webm|mp4|zip|ico|icns)$/i;

/** Build outputs and installed packages, for a tree that is not a git checkout (.gitignore). */
const IGNORED =
  /(^|\/)(node_modules|dist|coverage|\.mochi-cache|\.git)(\/|$)|^assets\/models\/|^packages\/desktop\/(app|out)\/|\.tsbuildinfo$/;

/** The tracked files; in a tree that is not a git checkout (an exported archive), every file. */
function trackedFiles(): string[] {
  let files: string[];
  if (existsSync(join(ROOT, '.git')))
    files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  else {
    files = readdirSync(ROOT, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) =>
        join(e.parentPath, e.name)
          .slice(ROOT.length + 1)
          .split('\\')
          .join('/'),
      )
      .filter((f) => !IGNORED.test(f));
  }
  return files.filter((f) => f && !f.startsWith('cleanroom/') && !EXEMPT.has(f) && !BINARY.test(f));
}

describe('public text', () => {
  it('has no private references outside the clean-room folder', () => {
    const found: string[] = [];
    for (const f of trackedFiles()) {
      let text: string;
      try {
        text = readFileSync(join(ROOT, f), 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, i) => {
        for (const [re, why] of PATTERNS)
          if (re.test(line)) found.push(`${f}:${i + 1}: ${why}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('has the README’s trademark footer, patent notice and «How it was made» word for word', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const text of [
      'Live2D and Live2D Cubism are trademarks or registered trademarks of Live2D Inc. VTube Studio is a product of DenchiSoft. Mochi Maker is an independent project. It is not affiliated with, endorsed by, sponsored by or supported by either, and it contains none of their code or files.',
      '## Patents\n\nThis project is licensed under the MIT License, which grants no patent rights. Reading some model files uses techniques, such as joining meshes ("glue") and blend shapes, that may be covered by third-party patents in some countries, including Japan and the United States. The project has taken no legal opinion on this, and makes no statement that any patent is or is not infringed. If you use or distribute it in such a country, above all commercially, check for yourself whether you need a license.',
      "**How it was made.** Most of this code was written by AI coding agents (Anthropic's Claude) under the direction of the project's maintainer, through the clean-room process in [CLEANROOM.md](CLEANROOM.md). Copyright may not subsist in every part of it. To the extent it does, it is licensed under the MIT License. Either way, it is provided as is, without warranty. Third-party code keeps its own licenses ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).",
    ])
      expect(readme).toContain(text);
    // The footer comes last, after the patent notice.
    expect(readme.indexOf('## Patents')).toBeLessThan(
      readme.indexOf('Live2D and Live2D Cubism are'),
    );
    expect(readme.trimEnd().endsWith('none of their code or files.')).toBe(true);
  });
});
