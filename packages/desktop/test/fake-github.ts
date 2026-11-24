/**
 * A stand-in for the parts of GitHub's REST API that the release scripts use (github.mjs), for
 * one repository, `o/r`: tags, releases (drafts included), their files and the uploads. It keeps
 * its state in memory, so a test can look at what is left after a step, change it between steps
 * (a person pushing a tag), or change it in the middle of one (`hooks`).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface FakeAsset {
  id: number;
  name: string;
  size: number;
  data: Buffer;
}
export interface FakeRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  assets: FakeAsset[];
}
export interface FakeState {
  /** Whether the repository is private (true unless a test says otherwise). */
  private?: boolean;
  /** Tag name → the commit it points at. */
  tags: Record<string, string>;
  releases: FakeRelease[];
}
export interface FakeHooks {
  /** Called when a PATCH arrives, before it is applied (a tag pushed at that moment). */
  beforePatch?: (state: FakeState) => void;
  /** Called after a PATCH is applied. */
  afterPatch?: (state: FakeState, release: FakeRelease) => void;
  /** A file whose stored bytes differ from what was uploaded. */
  corrupt?: string;
}
export interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  contentLength: string | undefined;
  transferEncoding: string | undefined;
}

const body = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (d: Buffer) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });

const view = ({ assets, ...r }: FakeRelease) => ({
  ...r,
  assets: assets.map(({ id, name, size }) => ({ id, name, size })),
});

export async function fakeGitHub(init: Partial<FakeState> = {}, hooks: FakeHooks = {}) {
  const state: FakeState = {
    private: init.private ?? true,
    tags: { ...init.tags },
    releases: [...(init.releases ?? [])],
  };
  const seen: Seen[] = [];
  let next = 1000;
  let url = '';
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url!, url);
    const p = u.pathname;
    seen.push({
      method: req.method!,
      url: req.url!,
      authorization: req.headers.authorization,
      contentLength: req.headers['content-length'],
      transferEncoding: req.headers['transfer-encoding'],
    });
    const json = (status: number, value?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    const find = (id: string) => state.releases.find((r) => r.id === Number(id));
    let m: RegExpMatchArray | null;
    const repo = '/repos/o/r';

    if (req.method === 'GET' && p === repo)
      return json(200, { full_name: 'o/r', private: state.private });
    if (req.method === 'GET' && (m = p.match(/^\/repos\/o\/r\/git\/ref\/tags\/(.+)$/))) {
      const name = decodeURIComponent(m[1]!);
      const sha = state.tags[name];
      return sha
        ? json(200, { ref: `refs/tags/${name}`, object: { type: 'commit', sha } })
        : json(404, { message: 'Not Found' });
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/repos\/o\/r\/git\/refs\/tags\/(.+)$/))) {
      const name = decodeURIComponent(m[1]!);
      if (!(name in state.tags)) return json(422, { message: 'Reference does not exist' });
      delete state.tags[name];
      return json(204);
    }
    if (p === `${repo}/releases` && req.method === 'GET')
      return json(200, u.searchParams.get('page') === '1' ? state.releases.map(view) : []);
    if (p === `${repo}/releases` && req.method === 'POST') {
      const b = JSON.parse((await body(req)).toString());
      const r: FakeRelease = {
        id: next++,
        tag_name: b.tag_name,
        target_commitish: b.target_commitish,
        name: b.name,
        body: b.body,
        draft: b.draft,
        prerelease: b.prerelease,
        assets: [],
      };
      state.releases.push(r);
      return json(201, {
        ...view(r),
        upload_url: `${url}/uploads${repo}/releases/${r.id}/assets{?name,label}`,
      });
    }
    if (
      (m = p.match(/^\/uploads\/repos\/o\/r\/releases\/(\d+)\/assets$/)) &&
      req.method === 'POST'
    ) {
      const r = find(m[1]!);
      if (!r) return json(404);
      const data = await body(req);
      const a = { id: next++, name: u.searchParams.get('name')!, size: data.length, data };
      r.assets.push(a);
      return json(201, { id: a.id, name: a.name, size: a.size });
    }
    if ((m = p.match(/^\/repos\/o\/r\/releases\/(\d+)\/assets$/)) && req.method === 'GET') {
      const r = find(m[1]!);
      return r ? json(200, view(r).assets) : json(404);
    }
    if ((m = p.match(/^\/repos\/o\/r\/releases\/assets\/(\d+)$/)) && req.method === 'GET') {
      if (req.headers.accept !== 'application/octet-stream') return json(415);
      res.writeHead(302, { location: `${url}/storage/${m[1]}` });
      return res.end();
    }
    if ((m = p.match(/^\/storage\/(\d+)$/))) {
      const a = state.releases.flatMap((r) => r.assets).find((x) => x.id === Number(m![1]));
      if (!a) return json(404);
      res.writeHead(200, { 'content-type': 'application/zip' });
      return res.end(hooks.corrupt === a.name ? Buffer.concat([a.data, Buffer.from('!')]) : a.data);
    }
    if ((m = p.match(/^\/repos\/o\/r\/releases\/(\d+)$/))) {
      const r = find(m[1]!);
      if (!r) return json(404, { message: 'Not Found' });
      if (req.method === 'GET') return json(200, view(r));
      if (req.method === 'DELETE') {
        state.releases.splice(state.releases.indexOf(r), 1);
        return json(204);
      }
      if (req.method === 'PATCH') {
        const b = JSON.parse((await body(req)).toString());
        hooks.beforePatch?.(state);
        // Publishing creates the tag at the release's commit, unless the tag exists already.
        if (b.draft === false && !(r.tag_name in state.tags))
          state.tags[r.tag_name] = r.target_commitish;
        Object.assign(r, b);
        hooks.afterPatch?.(state, r);
        return json(200, view(r));
      }
    }
    json(500, { message: `the stand-in has no ${req.method} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    state,
    seen,
    env: { GITHUB_API_URL: url, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'token-123' },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
