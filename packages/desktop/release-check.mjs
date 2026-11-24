// The release gate: run by the Desktop workflow before anything is built, and again right before
// the release is created.
//
//   node release-check.mjs [tag]   on a checkout: the version, its changelog section, and the tag
//   node release-check.mjs --github  in the workflow: the same, plus what the run is and what
//                                  already exists on GitHub (below)
//
// A release starts in one of two ways, and the gate knows which from the run:
//
// - **tag:** a tag `v<version>` was pushed (the event is a push). The tag must be `v` plus
//   package.json's version, and no release may exist for it yet (published or draft).
// - **dispatch:** the workflow was run by hand with «release» checked. The run must be on the
//   branch main, and neither the tag `v<version>` nor a release for it may exist yet: the release
//   creates the tag, at the run's commit.
//
// - **rehearsal:** run by hand with «rehearsal» checked (and «release» not): the whole release
//   path with a throwaway tag `rehearsal-<run number>` at the run's commit, which the release job
//   removes again. Only in a private repository, and only while neither that tag nor a release
//   for it exists. It never looks at, or touches, `v<version>`.
//
// Any other run releases nothing: by hand without «release» (from any ref, a tag's included), or
// anything else. Only the version and the changelog are checked then. In every case CHANGELOG.md
// must have a section for the version. Prints the version and how the run starts; in the
// workflow, writes `version`, `tag` and `start` (tag, dispatch, rehearsal or none) to the step's outputs;
// for a rehearsal, `tag` is the throwaway tag.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { github } from './github.mjs';

/** The throwaway tag of a rehearsal: `rehearsal-<run number>`. */
export const rehearsalTag = (runNumber) => `rehearsal-${runNumber}`;
export const REHEARSAL_TAG = /^rehearsal-\d+$/;

/**
 * The problems with releasing (none when it may go ahead).
 * - `start`: 'tag', 'dispatch', 'rehearsal', or undefined (no release: a check only);
 * - for a rehearsal: `rehearsal` (its tag), `isPrivate` (the repository), `releaseToo`
 *   («release» checked as well); `tagExists` and `releases` are then about the rehearsal's tag;
 * - `tag`: the pushed tag (start 'tag'), or a tag given by hand on a checkout;
 * - `ref`: the run's ref (start 'dispatch' must be refs/heads/main);
 * - `tagExists`, `releases`: what GitHub has for `v<version>` (releases: { draft } each).
 */
export function releaseProblems({
  version,
  changelog,
  tag,
  start,
  ref,
  tagExists,
  releases,
  rehearsal,
  isPrivate,
  releaseToo,
}) {
  const problems = [];
  const want = `v${version}`;
  if (start === 'rehearsal') {
    if (releaseToo)
      problems.push(
        '«rehearsal» and «release» cannot both be checked: a rehearsal makes no release.',
      );
    if (isPrivate !== true)
      problems.push(
        'A rehearsal is made only in a private repository, and this one is not. Nothing is built.',
      );
    if (!REHEARSAL_TAG.test(rehearsal ?? ''))
      problems.push(`The rehearsal's tag "${rehearsal}" is not rehearsal-<run number>.`);
    if (tagExists)
      problems.push(
        `The tag ${rehearsal} exists already (a rehearsal that did not clean up?). Nothing is built.`,
      );
    for (const r of releases ?? [])
      problems.push(
        `A ${r.draft ? 'draft ' : ''}release for ${rehearsal} exists already (a rehearsal that did not clean up?). Nothing is built.`,
      );
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    problems.push(`package.json's version "${version}" is not a version (major.minor.patch).`);
  if (tag !== undefined && tag !== want)
    problems.push(
      `The tag "${tag}" is not the version: package.json says ${version}, so the tag must be ${want}.`,
    );
  if (start === 'dispatch') {
    if (ref !== 'refs/heads/main')
      problems.push(`A release by hand is made from main, not from ${ref ?? 'an unknown ref'}.`);
    if (tagExists)
      problems.push(
        `The tag ${want} exists already: the release exists, or was made by a tag. Nothing is built.`,
      );
  }
  if (start === 'tag' || start === 'dispatch')
    for (const r of releases ?? [])
      problems.push(
        r.draft
          ? `A draft release for ${want} exists already (a run that did not finish?). Delete the draft, then run again.`
          : `The release ${want} exists already. Nothing is built.`,
      );
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^## \\[?${escaped}\\]?(\\s|$)`, 'm').test(changelog))
    problems.push(`CHANGELOG.md has no section for ${version} (a heading "## ${version}").`);
  return problems;
}

/**
 * How the run starts: 'tag' (a pushed tag), 'dispatch' (by hand, «release»), 'rehearsal' (by hand,
 * «rehearsal», whatever «release» says: the gate refuses both), or undefined.
 */
export function startOf(env) {
  const ref = env.GITHUB_REF ?? '';
  if (env.GITHUB_EVENT_NAME === 'push' && ref.startsWith('refs/tags/')) return 'tag';
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.REHEARSAL === 'true') return 'rehearsal';
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RELEASE === 'true') return 'dispatch';
  return undefined;
}

/** What the run is, and what GitHub has for the tag (start 'tag' or 'dispatch'). */
async function fromGitHub(version, env = process.env) {
  const start = startOf(env);
  const ref = env.GITHUB_REF ?? '';
  const facts = { start, ref, tag: start === 'tag' ? env.GITHUB_REF_NAME : undefined };
  if (!start) return facts;
  const gh = github(env);
  if (start === 'rehearsal') {
    // Only the rehearsal's own tag is looked at: never v<version>.
    const name = rehearsalTag(env.GITHUB_RUN_NUMBER);
    facts.rehearsal = name;
    facts.releaseToo = env.RELEASE === 'true';
    facts.isPrivate = (await gh.call('GET', ''))?.private;
    facts.tagExists = (await gh.tagCommit(name)) !== null;
    facts.releases = (await gh.releases())
      .filter((r) => r.tag_name === name)
      .map((r) => ({ draft: r.draft }));
    return facts;
  }
  const want = `v${version}`;
  facts.tagExists = (await gh.tagCommit(want)) !== null;
  facts.releases = (await gh.releases())
    .filter((r) => r.tag_name === want)
    .map((r) => ({ draft: r.draft }));
  return facts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../../', import.meta.url);
  const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
  const facts =
    process.argv[2] === '--github'
      ? await fromGitHub(version)
      : { tag: process.argv[2] || undefined };
  const problems = releaseProblems({ version, changelog, ...facts });
  if (problems.length) {
    for (const p of problems) console.error(`release check: ${p}`);
    process.exit(1);
  }
  const start = facts.start ?? 'none';
  const tag = start === 'rehearsal' ? facts.rehearsal : `v${version}`;
  console.log(
    `${version} (release: ${start === 'none' ? 'no' : start === 'rehearsal' ? `a rehearsal, ${tag}` : `by ${start}`})`,
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nstart=${start}\n`);
}
