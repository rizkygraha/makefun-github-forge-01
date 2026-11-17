// rest.ts — GitHub REST v3 under /api/v3.
//
// Routes implemented (the suite's contract; see checks-rest.ts):
//   GET  /api/v3/ | /api/v3/meta | /api/v3/user | /api/v3/user/repos
//   POST /api/v3/user/repos
//   GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}
//   GET  /api/v3/repos/{owner}/{repo}/branches[/{branch}]
//   GET  /api/v3/repos/{owner}/{repo}/commits[?sha=]
//   POST /api/v3/repos/{owner}/{repo}/git/refs
//   GET  /api/v3/repos/{owner}/{repo}/git/refs[/heads/{branch}]
//   GET/PUT/DELETE /api/v3/repos/{owner}/{repo}/contents/{path}
//   GET/POST /api/v3/repos/{owner}/{repo}/labels
//   GET/POST /api/v3/repos/{owner}/{repo}/issues[/{number}[/comments]]
//   PATCH /api/v3/repos/{owner}/{repo}/issues/{number}
//   GET/POST /api/v3/repos/{owner}/{repo}/pulls[/{number}[/files]]
//   PUT  /api/v3/repos/{owner}/{repo}/pulls/{number}/merge
//
// Every reply is application/json and carries X-GitHub-Request-Id (app.ts adds it).
// Errors carry {"message": string}. A repository belongs to the token's login; the same
// name under another owner is 404, never 403.

import { isOid, parseCommit, parseTree, ZERO_OID } from './gitproto.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  host: string;
  authed: boolean;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const err = (status: number, message: string): RestResponse => ({ status, body: { message } });
const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({ status, body, headers });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** True when the path matches one of the routes this forge implements at all. */
function isKnownRoute(segments: string[]): boolean {
  if (segments.length === 1 && segments[0] === 'user') return true;
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') return true;
  if (segments.length >= 3 && segments[0] === 'repos') {
    const rest = segments.slice(3);
    if (rest.length === 0) return true;
    const head = rest[0]!;
    if (head === 'branches' && rest.length <= 2) return true;
    if (head === 'commits' && rest.length === 1) return true;
    if (head === 'git' && rest[1] === 'refs') return true;
    if (head === 'contents') return true;
    if (head === 'labels' && rest.length === 1) return true;
    if (head === 'issues' && rest.length <= 3) return true;
    if (head === 'pulls' && rest.length <= 3) return true;
    return false;
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// JSON shapes
// -------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: VIEWER_ID, type: 'User', site_admin: false };
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length
    + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: store.globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: store.isoAt(repo.createdSeq),
    updated_at: store.isoAt(repo.createdSeq),
    pushed_at: store.isoAt(repo.createdSeq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: store.globalId('Issue', issue.dbId),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((entry) => entry.name === name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '' };
    }),
    user: userJson(VIEWER_LOGIN),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: store.isoAt(issue.createdSeq),
    updated_at: store.isoAt(issue.updatedSeq),
    closed_at: issue.closedSeq === null ? null : store.isoAt(issue.closedSeq),
    author_association: 'OWNER',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = store.resolveRef(repo, pull.head) ?? ZERO_OID;
  const baseSha = store.resolveRef(repo, pull.base) ?? ZERO_OID;
  return {
    id: pull.dbId,
    node_id: store.globalId('PullRequest', pull.dbId),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER_LOGIN),
    created_at: store.isoAt(pull.createdSeq),
    updated_at: store.isoAt(pull.updatedSeq),
    closed_at: pull.mergedSeq === null ? null : store.isoAt(pull.mergedSeq),
    merged_at: pull.mergedSeq === null ? null : store.isoAt(pull.mergedSeq),
    merge_commit_sha: pull.mergeSha,
    merged: pull.merged,
    mergeable: store.mergeableState(repo, pull) === 'MERGEABLE',
    mergeable_state: store.mergeableState(repo, pull).toLowerCase(),
    draft: false,
    head: {
      label: `${repo.owner}:${pull.head}`,
      ref: pull.head,
      sha: headSha,
      user: userJson(VIEWER_LOGIN),
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: baseSha,
      user: userJson(VIEWER_LOGIN),
      repo: repoJson(store, repo),
    },
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: { id: number; body: string; createdSeq: number; authorLogin: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: store.globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(comment.authorLogin),
    created_at: store.isoAt(comment.createdSeq),
    updated_at: store.isoAt(comment.createdSeq),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

// -------------------------------------------------------------------------------------------
// pagination
// -------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(perPageRaw) ? perPageRaw : 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], req: RestRequest, basePath: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(req.query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const url = `http://${req.host}${basePath}?per_page=${perPage}&page=${page + 1}`;
    headers.link = `<${url}>; rel="next"`;
  }
  return { page: [...pageItems], headers };
}

// -------------------------------------------------------------------------------------------
// repo lookup
// -------------------------------------------------------------------------------------------

function lookupRepo(req: RestRequest, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return req.store.getRepo(owner, name) ?? null;
}

function decodePath(segments: string[]): string {
  return segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }).join('/');
}

// -------------------------------------------------------------------------------------------
// contents helpers
// -------------------------------------------------------------------------------------------

/** The tree entry at a repo-relative path (file or directory), or null. */
function treeEntryAt(store: Store, treeOid: string, path: string): { mode: string; oid: string } | null {
  if (path === '') return { mode: '40000', oid: treeOid };
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = store.getObject(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function contentEntryJson(store: Store, repo: Repo, path: string, entry: { mode: string; oid: string }): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  if (entry.mode === '40000') {
    return {
      type: 'dir',
      size: 0,
      name,
      path,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
      download_url: null,
    };
  }
  const blob = store.getObject(entry.oid);
  const size = blob?.data.length ?? 0;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    content: blob ? blob.data.toString('base64') : '',
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
    download_url: `https://example.invalid/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
  };
}

/** Commit one file change on a branch; creates the branch when it does not exist yet. */
function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  data: Buffer,
  message: string,
): { commitSha: string; blobSha: string } {
  const existingTip = store.resolveRef(repo, branch);
  const parent = existingTip ?? store.resolveRef(repo, repo.defaultBranch);
  const baseTree = parent === null ? store.emptyTreeOid() : parseCommit(store.getObject(parent)!.data).tree;
  const flat = store.flattenTree(baseTree);
  const blobSha = store.putObject('blob', data);
  flat.set(path, { mode: '100644', name: path.split('/').pop()!, oid: blobSha });
  const treeOid = store.buildTreeFromMap(flat);
  const commitSha = store.makeCommit(treeOid, parent === null ? [] : [parent], message);
  store.getRepo(repo.owner, repo.name)!.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

// -------------------------------------------------------------------------------------------
// dispatcher
// -------------------------------------------------------------------------------------------

export function handleRest(req: RestRequest): RestResponse {
  const { store, method, segments } = req;

  // The API root and meta need no token (api.github.com answers them unauthenticated).
  if (method === 'GET' && segments.length === 0) {
    return ok(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  // An unknown route is a 404 even without a token (api.github.com behaves this way,
  // and the protocol checks call unknown routes without asserting auth first).
  if (!isKnownRoute(segments)) return err(404, 'Not Found');
  if (!req.authed) return err(401, 'Requires authentication');

  // GET /user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { ...userJson(VIEWER_LOGIN), name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' });
  }

  // /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN).map((repo) => repoJson(store, repo));
      const { page, headers } = paginate(repos, req, '/api/v3/user/repos');
      return ok(200, page, headers);
    }
    if (method === 'POST') {
      const body = isRecord(req.body) ? req.body : {};
      const name = str(body.name);
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'Invalid repository name');
      const repo = store.createRepo(VIEWER_LOGIN, name, bool(body.private, false), str(body.description));
      if (repo === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(store, repo));
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const name = segments[2]!;
    const rest = segments.slice(3);
    const repo = lookupRepo(req, owner, name);
    if (repo === null) return err(404, 'Not Found');

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        const body = isRecord(req.body) ? req.body : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .sort()
          .map((ref) => ({
            name: ref.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(ref), url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(ref)}` },
            protected: false,
          }));
        return ok(200, branches);
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = rest[1]!;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        return ok(200, {
          name: branch,
          commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` },
          protected: false,
        });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) return err(404, 'Not Found');
      const commits = store.walkCommits(tip).map((sha) => {
        const commit = parseCommit(store.getObject(sha)!.data);
        const parseIdentity = (text: string): { name: string; email: string; date: string } => {
          const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(text);
          if (!match) return { name: text, email: '', date: store.isoAt(0) };
          return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
        };
        return {
          sha,
          commit: {
            // GitHub's REST view presents the message without the trailing
            // newline git stores in the commit object.
            message: commit.message.replace(/\n$/, ''),
            author: parseIdentity(commit.author),
            committer: parseIdentity(commit.committer),
            tree: { sha: commit.tree },
          },
          parents: commit.parents.map((parent) => ({ sha: parent })),
          url: `/api/v3/repos/${owner}/${name}/commits/${sha}`,
          html_url: `https://example.invalid/${owner}/${name}/commit/${sha}`,
        };
      });
      const { page } = paginate(commits, req, `/api/v3/repos/${owner}/${name}/commits`);
      return ok(200, page);
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = isRecord(req.body) ? req.body : {};
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'Invalid ref or sha');
        const object = store.getObject(sha);
        if (!object) return err(422, 'Object does not exist');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return ok(201, { ref, node_id: store.globalId('Ref', repo.id), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.slice(5)}`, object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${name}/git/${object.type}s/${sha}` } });
      }
      if (method === 'GET') {
        // GET /git/refs or /git/refs/heads/{branch}
        const refPath = rest.slice(2).join('/');
        if (refPath === '') {
          const refs = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, object: { sha, type: store.getObject(sha)?.type ?? 'commit' } }));
          return ok(200, refs);
        }
        const full = `refs/${refPath}`;
        const tip = repo.refs.get(full);
        if (tip === undefined) return err(404, 'Not Found');
        const object = store.getObject(tip);
        return ok(200, { ref: full, node_id: store.globalId('Ref', repo.id), url: `/api/v3/repos/${owner}/${name}/git/refs/${refPath}`, object: { sha: tip, type: object?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/${object?.type ?? 'commit'}s/${tip}` } });
      }
      return err(404, 'Not Found');
    }

    // contents
    if (rest[0] === 'contents') {
      const path = decodePath(rest.slice(1));
      if (method === 'GET') {
        const ref = req.query.get('ref') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (tip === null) return err(404, 'Not Found');
        const treeOid = parseCommit(store.getObject(tip)!.data).tree;
        const entry = treeEntryAt(store, treeOid, path);
        if (entry === null) return err(404, 'Not Found');
        if (path === '' || entry.mode === '40000') {
          // Directory listing: immediate children.
          const flat = store.flattenTree(treeOid);
          const prefix = path === '' ? '' : `${path}/`;
          const children = new Map<string, { mode: string; oid: string }>();
          for (const [filePath, fileEntry] of flat) {
            if (!filePath.startsWith(prefix)) continue;
            const restPath = filePath.slice(prefix.length);
            const first = restPath.split('/')[0]!;
            if (!children.has(first)) {
              if (restPath.includes('/')) {
                const dirEntry = treeEntryAt(store, treeOid, prefix + first);
                if (dirEntry) children.set(first, dirEntry);
              } else {
                children.set(first, fileEntry);
              }
            }
          }
          const listed = [...children.entries()]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([childName, childEntry]) => contentEntryJson(store, repo, prefix + childName, childEntry));
          return ok(200, listed);
        }
        return ok(200, contentEntryJson(store, repo, path, entry));
      }
      if (method === 'PUT') {
        const body = isRecord(req.body) ? req.body : {};
        const message = str(body.message) || `Update ${path}`;
        const contentB64 = str(body.content);
        if (contentB64 === '') return err(422, 'content is required');
        let data: Buffer;
        try {
          data = Buffer.from(contentB64, 'base64');
          if (data.toString('base64').replace(/=+$/, '') !== contentB64.replace(/=+$/, '').replace(/\s+/g, '')) throw new Error('bad base64');
        } catch {
          return err(400, 'content is not valid base64');
        }
        const branch = str(body.branch) || repo.defaultBranch;
        const sha = str(body.sha);
        const existingTip = store.resolveRef(repo, branch);
        const parent = existingTip ?? store.resolveRef(repo, repo.defaultBranch);
        const baseTree = parent === null ? store.emptyTreeOid() : parseCommit(store.getObject(parent)!.data).tree;
        const flat = store.flattenTree(baseTree);
        const existing = flat.get(path);
        if (existing !== undefined) {
          if (sha === '') return err(422, 'sha is required to update a file');
          if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
        } else if (sha !== '') {
          return err(422, 'sha given for a file that does not exist');
        }
        const { commitSha, blobSha } = commitFile(store, repo, branch, path, data, message);
        const status = existing !== undefined ? 200 : 201;
        return ok(status, {
          content: {
            name: path.split('/').pop(),
            path,
            sha: blobSha,
            size: data.length,
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          },
          commit: {
            sha: commitSha,
            message,
            author: { name: 'Plenger Forge', email: 'forge@plenger.invalid', date: store.isoAt(store.nextSeq()) },
            committer: { name: 'Plenger Forge', email: 'forge@plenger.invalid', date: store.isoAt(0) },
          },
        });
      }
      if (method === 'DELETE') {
        const body = isRecord(req.body) ? req.body : {};
        const message = str(body.message) || `Delete ${path}`;
        const branch = str(body.branch) || repo.defaultBranch;
        const tip = store.resolveRef(repo, branch);
        if (tip === null) return err(404, 'Not Found');
        const treeOid = parseCommit(store.getObject(tip)!.data).tree;
        const flat = store.flattenTree(treeOid);
        if (!flat.has(path)) return err(404, 'Not Found');
        flat.delete(path);
        const newTree = store.buildTreeFromMap(flat);
        const commitSha = store.makeCommit(newTree, [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        return ok(200, { commit: { sha: commitSha, message } });
      }
      return err(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, repo.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })));
      }
      if (method === 'POST' && rest.length === 1) {
        const body = isRecord(req.body) ? req.body : {};
        const name = str(body.name);
        if (name === '') return err(422, 'Label name is required');
        if (repo.labels.some((label) => label.name === name)) return err(422, 'Label already exists');
        const label = { name, color: str(body.color) || 'ededed', description: str(body.description) };
        repo.labels.push(label);
        return ok(201, { name: label.name, color: label.color, description: label.description });
      }
      return err(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          if (sort === 'created') {
            issues = [...issues].sort((a, b) => direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
          }
          const { page, headers } = paginate(issues.map((issue) => issueJson(store, repo, issue)), req, `/api/v3/repos/${owner}/${name}/issues`);
          return ok(200, page, headers);
        }
        if (method === 'POST') {
          const body = isRecord(req.body) ? req.body : {};
          const title = str(body.title);
          if (title === '') return err(422, 'Title is required');
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: string[] = [];
          for (const entry of rawLabels) {
            const labelName = typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.name) : '';
            if (labelName === '') continue;
            if (!repo.labels.some((label) => label.name === labelName)) return err(422, `Label "${labelName}" does not exist`);
            labels.push(labelName);
          }
          const issue = store.createIssue(repo, title, str(body.body), labels);
          return ok(201, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const issue = store.findIssue(repo, number);
      if (rest.length === 2) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          const body = isRecord(req.body) ? req.body : {};
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedSeq = body.state === 'closed' ? store.nextSeq() : null;
          }
          issue.updatedSeq = store.nextSeq();
          return ok(200, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') {
          return ok(200, issue.comments.map((comment) => commentJson(store, repo, issue, comment)));
        }
        if (method === 'POST') {
          const body = isRecord(req.body) ? req.body : {};
          const text = str(body.body);
          if (text === '') return err(422, 'Comment body is required');
          const comment = store.createComment(issue, text, VIEWER_LOGIN);
          return ok(201, commentJson(store, repo, issue, comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          pulls = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, headers } = paginate(pulls.map((pull) => pullJson(store, repo, pull)), req, `/api/v3/repos/${owner}/${name}/pulls`);
          return ok(200, page, headers);
        }
        if (method === 'POST') {
          const body = isRecord(req.body) ? req.body : {};
          const head = str(body.head).includes(':') ? str(body.head).split(':').pop()! : str(body.head);
          const base = str(body.base).includes(':') ? str(body.base).split(':').pop()! : str(body.base);
          const title = str(body.title);
          if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
          if (head === base) return err(422, 'head and base are the same');
          if (store.resolveRef(repo, head) === null) return err(422, `head branch "${head}" does not exist`);
          if (store.resolveRef(repo, base) === null) return err(422, `base branch "${base}" does not exist`);
          if (repo.pulls.some((pull) => pull.state === 'open' && pull.head === head && pull.base === base)) {
            return err(422, 'A pull request already exists for these branches');
          }
          const pull = store.createPull(repo, title, str(body.body), head, base);
          return ok(201, pullJson(store, repo, pull));
        }
        return err(404, 'Not Found');
      }
      const number = Number(rest[1]);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const pull = store.findPull(repo, number);
      if (rest.length === 2) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullJson(store, repo, pull));
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) return err(404, 'Not Found');
        const files = store.pullFiles(repo, pull).map((file) => ({
          filename: file.path,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        }));
        return ok(200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return err(404, 'Not Found');
        if (pull.merged) return err(405, 'Pull request already merged');
        const outcome = store.squashMerge(repo, pull);
        if (!outcome.ok) {
          if (outcome.reason === 'conflict') return err(405, 'Merge conflict');
          if (outcome.reason === 'already-merged') return err(405, 'Pull request already merged');
          return err(422, 'Cannot merge this pull request');
        }
        return ok(200, { sha: outcome.sha, merged: true, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
