// GitHub's REST API, for the release scripts (release-check.mjs, release.mjs), with the run's own
// token. The address comes from GITHUB_API_URL (set on every runner; the tests point it at a
// stand-in), the repository from GITHUB_REPOSITORY.

/** A client for one repository. */
export function github(env = process.env) {
  const base = env.GITHUB_API_URL || 'https://api.github.com';
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const auth = token ? { authorization: `Bearer ${token}` } : {};

  /** The raw response; `path` is under /repos/{repo}, or a full URL (an upload URL). */
  async function request(method, path, { json, body, headers, redirect } = {}) {
    const url = /^https?:\/\//.test(path) ? path : `${base}/repos/${repo}${path}`;
    return fetch(url, {
      method,
      redirect: redirect ?? 'follow',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...auth,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
      ...(body && typeof body !== 'string' ? { duplex: 'half' } : {}),
    });
  }

  /**
   * The JSON answer, or null for an empty one (as a DELETE gives). A read that gets a 404 gives
   * null too (the thing is not there); a write that gets a 404 is an error, where it happens.
   * An error carries the answer's `status` (none when no answer came).
   */
  async function call(method, path, options) {
    const res = await request(method, path, options);
    if (res.status === 404 && method === 'GET') return null;
    const text = await res.text();
    if (!res.ok)
      throw Object.assign(new Error(`GitHub ${method} ${path}: ${res.status} ${text}`), {
        status: res.status,
      });
    return text ? JSON.parse(text) : null;
  }

  /**
   * The commit the tag `name` points at, or null when there is no such tag (the exact ref:
   * refs/tags/v0.1.0-rc.1 is another tag). An annotated tag is followed to its commit.
   */
  async function tagCommit(name) {
    const ref = await call('GET', `/git/ref/tags/${encodeURIComponent(name)}`);
    if (!ref || ref.ref !== `refs/tags/${name}`) return null;
    let object = ref.object;
    while (object?.type === 'tag') object = (await call('GET', `/git/tags/${object.sha}`)).object;
    return object?.sha ?? null;
  }

  /** Every release, drafts included (the token sees drafts with contents: write). */
  async function releases() {
    const all = [];
    for (let page = 1; ; page++) {
      const list = (await call('GET', `/releases?per_page=100&page=${page}`)) ?? [];
      all.push(...list);
      if (list.length < 100) return all;
    }
  }

  return { repo, request, call, tagCommit, releases };
}
