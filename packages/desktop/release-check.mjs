// The release gate: run by the Desktop workflow before anything is built, and again right before
// the release is created.
//
//   node release-check.mjs [tag]   on a checkout: the version, its changelog section, and the tag
//   node release-check.mjs --github  in the workflow: the same, plus what the run is and what
//                                  already exists on GitHub (below)
//
// A release starts in one of two ways, and the gate knows which from the run:
//
// - **tag:** a tag `v<version>` was pushed. The tag must be `v` plus package.json's version, and
//   no release may exist for it yet (published or draft).
// - **dispatch:** the workflow was run by hand with «release» checked. The run must be on the
//   branch main, and neither the tag `v<version>` nor a release for it may exist yet: the release
//   creates the tag, at the run's commit.
//
// Any other run (by hand without «release», or anything else) releases nothing: only the version
// and the changelog are checked. In every case CHANGELOG.md must have a section for the version.
// Prints the version and how the run starts; in the workflow, writes `version`, `tag` and
// `start` (tag, dispatch or none) to the step's outputs.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The problems with releasing (none when it may go ahead).
 * - `start`: 'tag', 'dispatch', or undefined (no release: a check only);
 * - `tag`: the pushed tag (start 'tag'), or a tag given by hand on a checkout;
 * - `ref`: the run's ref (start 'dispatch' must be refs/heads/main);
 * - `tagExists`, `releases`: what GitHub has for `v<version>` (releases: { draft } each).
 */
export function releaseProblems({ version, changelog, tag, start, ref, tagExists, releases }) {
  const problems = [];
  const want = `v${version}`;
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
    problems.push(`package.json's version "${version}" is not a version (major.minor.patch).`);
  if (tag !== undefined && tag !== want)
    problems.push(
      `The tag "${tag}" is not the version: package.json says ${version}, so the tag must be ${want}.`,
    );
  if (start === 'dispatch') {
    if (ref !== 'refs/heads/main')
      problems.push(
        `A release run by hand must be started on the branch main, not on ${ref ?? 'an unknown ref'}.`,
      );
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

/** A GitHub API call with the run's token; null for a 404. */
async function github(path) {
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const res = await fetch(`${api}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return { body: await res.json(), link: res.headers.get('link') ?? '' };
}

/** What the run is, and what GitHub has for the tag (start 'tag' or 'dispatch'). */
async function fromGitHub(version) {
  const env = process.env;
  const ref = env.GITHUB_REF ?? '';
  const start = ref.startsWith('refs/tags/')
    ? 'tag'
    : env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RELEASE === 'true'
      ? 'dispatch'
      : undefined;
  const facts = { start, ref, tag: start === 'tag' ? env.GITHUB_REF_NAME : undefined };
  if (!start) return facts;
  const repo = env.GITHUB_REPOSITORY;
  const want = `v${version}`;
  // The exact ref (refs/tags/v0.1.0), not a prefix match: refs/tags/v0.1.0-rc.1 is another tag.
  const found = await github(`/repos/${repo}/git/ref/tags/${encodeURIComponent(want)}`);
  facts.tagExists = found !== null && found.body.ref === `refs/tags/${want}`;
  // Every release, drafts included (the token can see them with contents: write).
  facts.releases = [];
  for (let page = 1; ; page++) {
    const r = await github(`/repos/${repo}/releases?per_page=100&page=${page}`);
    const list = r?.body ?? [];
    for (const x of list) if (x.tag_name === want) facts.releases.push({ draft: x.draft });
    if (list.length < 100) break;
  }
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
  console.log(`${version} (release: ${start === 'none' ? 'no' : `by ${start}`})`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\ntag=v${version}\nstart=${start}\n`,
    );
}
