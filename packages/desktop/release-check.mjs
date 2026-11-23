// The release gate: run by the Desktop workflow before anything is built or published.
//
//   node release-check.mjs [tag]
//
// Fails unless CHANGELOG.md has a section for the version in the root package.json, and, given
// a tag, unless the tag is `v` plus that version. Prints the version on success.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The problems with releasing `tag` (none when it may be released). */
export function releaseProblems({ version, changelog, tag }) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    problems.push(`package.json's version "${version}" is not a version (major.minor.patch).`);
  if (tag !== undefined && tag !== `v${version}`)
    problems.push(
      `The tag "${tag}" is not the version: package.json says ${version}, so the tag must be v${version}.`,
    );
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`, 'm').test(changelog))
    problems.push(`CHANGELOG.md has no section for ${version} (a heading "## ${version}").`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../../', import.meta.url);
  const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
  const tag = process.argv[2] || undefined;
  const problems = releaseProblems({ version, changelog, tag });
  if (problems.length) {
    for (const p of problems) console.error(`release check: ${p}`);
    process.exit(1);
  }
  console.log(version);
}
