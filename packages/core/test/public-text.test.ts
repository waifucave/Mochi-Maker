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

/**
 * The limit for the tests here that read every file in the repository: the longest took 0.86 s on
 * two busy cores.
 */
const WORK = 30_000;

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
  [/\b(this|that|next|last|previous) round\b|\bround reports?\b/i, 'a development round'],
  [/\bguide section \d|\bsection \d+(\.\d+)* of the guide\b/i, 'the private conventions guide'],
  // Model import is "open" or "import", never these.
  [/\b(rip|rips|ripped|ripping)\b/i, 'wording to keep out of model import'],
  [
    /^(?!.*I have not viewed, decompiled or copied).*\bdecompil/i,
    'wording to keep out of model import',
  ],
  [
    /\bextract(s|ed|ing|ion)? (a |an |the )?(\.?moc3|models?)\b|\bmodel extract|\bextract mode\b|\bextractor\b/i,
    'wording to keep out of model import',
  ],
  [
    /recover any model|convert(ing)? Cubism models|migrat(e|es|ing|ion) from Cubism|no Cubism licen[cs]e/i,
    'wording to keep out of model import',
  ],
  [/Cubism 5\.1/, 'a product version used as a reference'],
  // What the project states in public rests on what the repository holds and tests.
  [
    /\breal models? checked locally\b|\bchecked locally by the project\b/i,
    'a check the repository does not hold',
  ],
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

/**
 * The files a commit would hold: tracked ones and new ones not ignored (a new file is checked before
 * it is committed). In a tree that is not a git checkout (an exported archive), every file.
 */
function trackedFiles(): string[] {
  let files: string[];
  if (existsSync(join(ROOT, '.git')))
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f && existsSync(join(ROOT, f)));
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
  it('has no private references outside the clean-room folder', { timeout: WORK }, () => {
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
