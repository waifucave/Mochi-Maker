// The release job's steps, after the gate (release-check.mjs). One path for every start: a pushed
// tag, a run by hand with «release», and a rehearsal (by hand with «rehearsal», in a private
// repository), which goes the same way with a throwaway tag and then removes what it made:
//
//   node release.mjs draft     the draft pre-release, with the notes and the four zips in dist/;
//                              writes its id to the step's outputs (`id`)
//   node release.mjs files     downloads every file of the draft back; each must be one of the
//                              four, byte for byte (SHA-256)
//   node release.mjs publish   reads the tag again, then publishes the draft
//   node release.mjs verify    the tag points at the run's commit; a published pre-release
//   node release.mjs remove    a rehearsal's end: the cleanup, then a check that nothing is left
//   node release.mjs cleanup   after a failure: deletes what this run made, and nothing else
//
// From the environment: TAG, VERSION and START (the gate's outputs), RELEASE_ID (the draft's id,
// from `draft`), GITHUB_SHA (the run's commit), DIST (default dist), and the API's address,
// repository and token (github.mjs).
//
// **The tag rule** (tagProblems), read before the draft is created and again right before it is
// published: on a pushed tag, the tag must point at the run's commit; by hand, there must be no
// tag yet, since publishing creates it at the run's commit. This rule is the only difference
// between the starts: every call is the same. A rehearsal follows the rule of a run by hand, and
// its tag must be `rehearsal-<run number>`: every step refuses any other tag for it, so a
// rehearsal can never create, replace or delete `v<version>` or its release.
//
// **The cleanup rule** (cleanupPlan): it deletes only the release this run created (by its id,
// draft or published, and only if it still carries this run's tag), and a tag only if the run was
// started by hand or is a rehearsal, this run published the release, and the tag points at this
// run's commit. A tag pushed by a person is never deleted.
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { github } from './github.mjs';
import { REHEARSAL_TAG } from './release-check.mjs';

/** The four zips a release holds. */
export const RELEASE_FILES = [
  'mochi-maker-win32-x64.zip',
  'mochi-maker-darwin-arm64.zip',
  'mochi-maker-darwin-x64.zip',
  'mochi-maker-linux-x64.zip',
];

/** What is wrong with the tag, for the run's start (none when the release may go on). */
export function tagProblems({ start, tag, tagSha, sha }) {
  if (start === 'tag') {
    if (tagSha === null) return [`The tag ${tag} is gone: nothing is published.`];
    if (tagSha !== sha)
      return [
        `The tag ${tag} points at ${tagSha}, not at this run's commit ${sha}: nothing is published.`,
      ];
    return [];
  }
  if (start === 'dispatch' || start === 'rehearsal') {
    if (start === 'rehearsal' && !REHEARSAL_TAG.test(tag))
      return [`A rehearsal uses only a tag rehearsal-<run number>, never ${tag}.`];
    if (tagSha !== null)
      return [
        `The tag ${tag} appeared after the gate, at ${tagSha} (pushed while this run built?): nothing is published.`,
      ];
    return [];
  }
  return [`This run makes no release (start "${start}").`];
}

/**
 * What the cleanup deletes. `release` is the release with this run's id as GitHub has it now
 * (null if there is none); `tagSha` the commit the tag points at now (null if none).
 */
export function cleanupPlan({ start, tag, sha, release, tagSha }) {
  if (start === 'rehearsal' && !REHEARSAL_TAG.test(tag ?? ''))
    return { release: false, tag: false };
  const ours = release !== null && release.tag_name === tag;
  const publishedByRun = ours && release.draft === false;
  const madeTag = start === 'dispatch' || start === 'rehearsal';
  return {
    release: ours,
    tag: madeTag && publishedByRun && tagSha !== null && tagSha === sha,
  };
}

/** The release's title: a rehearsal's says so. */
export const releaseTitle = (version, start, tag) =>
  start === 'rehearsal'
    ? `REHEARSAL ${tag}: Mochi Maker ${version} (made and removed by the workflow, not a release)`
    : `Mochi Maker ${version}`;

const sha256 = (stream) =>
  new Promise((resolve, reject) => {
    const h = createHash('sha256');
    stream.on('data', (d) => h.update(d));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });

/** The four zips in `dist`, each with its size and SHA-256; anything else there is refused. */
async function built(dist) {
  const names = readdirSync(dist).filter((n) => n.endsWith('.zip'));
  const missing = RELEASE_FILES.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !RELEASE_FILES.includes(n));
  if (missing.length || extra.length)
    throw new Error(
      `dist must hold exactly the four zips: ${[...missing.map((n) => `missing ${n}`), ...extra.map((n) => `unexpected ${n}`)].join(', ')}.`,
    );
  const files = [];
  for (const name of RELEASE_FILES) {
    const path = join(dist, name);
    files.push({
      name,
      path,
      size: statSync(path).size,
      sha256: await sha256(createReadStream(path)),
    });
  }
  return files;
}

const notes = (version) =>
  readFileSync(new URL('release-notes.md', import.meta.url), 'utf8').replaceAll(
    '{{version}}',
    version,
  );

function output(env, values) {
  if (!env.GITHUB_OUTPUT) return;
  appendFileSync(
    env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(''),
  );
}

function need(env, ...names) {
  for (const n of names) if (!env[n]) throw new Error(`release.mjs needs ${n}.`);
}

/** A rehearsal's steps refuse any tag but rehearsal-<run number>. */
function guard(env) {
  if (env.START === 'rehearsal' && !REHEARSAL_TAG.test(env.TAG ?? ''))
    throw new Error(`A rehearsal uses only a tag rehearsal-<run number>, never ${env.TAG}.`);
}

async function checkTag(gh, env) {
  const tagSha = await gh.tagCommit(env.TAG);
  const problems = tagProblems({ start: env.START, tag: env.TAG, tagSha, sha: env.GITHUB_SHA });
  if (problems.length) throw new Error(problems.join('\n'));
}

/** The steps, by name; each throws on a problem. `log` prints a line. */
export const steps = {
  async draft(env, log) {
    need(env, 'TAG', 'VERSION', 'START', 'GITHUB_SHA');
    guard(env);
    const gh = github(env);
    const files = await built(env.DIST || 'dist');
    await checkTag(gh, env);
    const release = await gh.call('POST', '/releases', {
      json: {
        tag_name: env.TAG,
        target_commitish: env.GITHUB_SHA,
        name: releaseTitle(env.VERSION, env.START, env.TAG),
        body:
          env.START === 'rehearsal'
            ? `**REHEARSAL** of the release path, at ${env.GITHUB_SHA}: removed again by the run that made it.\n\n${notes(env.VERSION)}`
            : notes(env.VERSION),
        draft: true,
        prerelease: true,
      },
    });
    // At once, so that the cleanup knows this draft whatever fails after.
    output(env, { id: release.id });
    log(`draft ${release.id} for ${env.TAG} at ${env.GITHUB_SHA}`);
    const upload = release.upload_url.replace(/\{.*\}$/, '');
    for (const f of files) {
      const res = await gh.request('POST', `${upload}?name=${encodeURIComponent(f.name)}`, {
        headers: { 'content-type': 'application/zip', 'content-length': String(f.size) },
        body: Readable.toWeb(createReadStream(f.path)),
      });
      if (!res.ok) throw new Error(`Uploading ${f.name}: ${res.status} ${await res.text()}`);
      log(`uploaded ${f.name} (${f.size} bytes)`);
    }
  },

  async files(env, log) {
    need(env, 'RELEASE_ID');
    const gh = github(env);
    const files = await built(env.DIST || 'dist');
    const assets = (await gh.call('GET', `/releases/${env.RELEASE_ID}/assets?per_page=100`)) ?? [];
    const names = assets.map((a) => a.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...RELEASE_FILES].sort()))
      throw new Error(`The draft holds ${names.join(', ') || 'no files'}, not the four zips.`);
    for (const f of files) {
      const asset = assets.find((a) => a.name === f.name);
      // The API answers with a redirect to the file's storage; that request carries no token.
      const res = await gh.request('GET', `/releases/assets/${asset.id}`, {
        headers: { accept: 'application/octet-stream' },
        redirect: 'manual',
      });
      const from =
        res.status >= 300 && res.status < 400
          ? await fetch(new URL(res.headers.get('location'), res.url))
          : res;
      if (!from.ok) throw new Error(`Downloading ${f.name}: ${from.status}`);
      const back = await sha256(Readable.fromWeb(from.body));
      if (back !== f.sha256)
        throw new Error(`${f.name} in the draft is ${back}, not the built ${f.sha256}.`);
      log(`${back}  ${f.name}`);
    }
  },

  async publish(env, log) {
    need(env, 'TAG', 'START', 'RELEASE_ID', 'GITHUB_SHA');
    guard(env);
    const gh = github(env);
    await checkTag(gh, env);
    await gh.call('PATCH', `/releases/${env.RELEASE_ID}`, { json: { draft: false } });
    log(`published ${env.TAG}`);
  },

  async verify(env, log) {
    need(env, 'TAG', 'RELEASE_ID', 'GITHUB_SHA');
    const gh = github(env);
    const tagSha = await gh.tagCommit(env.TAG);
    if (tagSha !== env.GITHUB_SHA)
      throw new Error(`The tag ${env.TAG} is at ${tagSha ?? 'nothing'}, not ${env.GITHUB_SHA}.`);
    const r = await gh.call('GET', `/releases/${env.RELEASE_ID}`);
    if (!r || r.draft || !r.prerelease || r.tag_name !== env.TAG)
      throw new Error(`The release is not a published pre-release of ${env.TAG}.`);
    log(
      JSON.stringify({ name: r.name, tag: r.tag_name, draft: r.draft, prerelease: r.prerelease }),
    );
  },

  async remove(env, log) {
    need(env, 'TAG', 'START', 'RELEASE_ID', 'GITHUB_SHA');
    if (env.START !== 'rehearsal') throw new Error("remove is a rehearsal's last step only.");
    guard(env);
    await steps.cleanup(env, log);
    // Nothing of the rehearsal may be left: no release or draft for its tag, and no tag.
    const gh = github(env);
    let left;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, Number(env.REMOVE_WAIT_MS ?? 3000)));
      const releases = (await gh.releases()).filter((r) => r.tag_name === env.TAG);
      const tagSha = await gh.tagCommit(env.TAG);
      left = [
        ...releases.map((r) => `the ${r.draft ? 'draft' : 'release'} ${r.id}`),
        ...(tagSha ? [`the tag ${env.TAG} at ${tagSha}`] : []),
      ];
      if (left.length === 0) return log(`nothing left of ${env.TAG}: no release, no draft, no tag`);
    }
    throw new Error(`The rehearsal could not clean up: ${left.join(', ')} is left.`);
  },

  async cleanup(env, log) {
    if (!env.TAG || !env.RELEASE_ID) return log('nothing to clean: this run created no release');
    const gh = github(env);
    const release = await gh.call('GET', `/releases/${env.RELEASE_ID}`);
    const tagSha = await gh.tagCommit(env.TAG);
    const plan = cleanupPlan({
      start: env.START,
      tag: env.TAG,
      sha: env.GITHUB_SHA,
      release,
      tagSha,
    });
    if (release !== null && !plan.release)
      log(`kept the release ${env.RELEASE_ID}: its tag is ${release.tag_name}, not ${env.TAG}`);
    if (plan.release) {
      await gh.call('DELETE', `/releases/${env.RELEASE_ID}`);
      log(`deleted the ${release.draft ? 'draft' : 'release'} ${env.RELEASE_ID}`);
    }
    if (plan.tag) {
      await gh.call('DELETE', `/git/refs/tags/${encodeURIComponent(env.TAG)}`);
      log(`deleted the tag ${env.TAG}, made by this run at ${tagSha}`);
    } else if (tagSha !== null) log(`kept the tag ${env.TAG} (at ${tagSha})`);
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const step = steps[process.argv[2]];
  if (!step) {
    console.error(`usage: node release.mjs ${Object.keys(steps).join('|')}`);
    process.exit(2);
  }
  try {
    await step(process.env, (line) => console.log(line));
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exit(1);
  }
}
