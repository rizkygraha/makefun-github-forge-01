// store.ts — the forge's whole state: one in-memory store shared by git smart HTTP,
// REST v3, GraphQL v4 and MCP. No persistence is needed: a trial starts with an empty
// forge and the suite seeds everything it needs through the API.
//
// Determinism: every id is a counter, every timestamp derives from MAKEFUN_TRIAL_NOW
// (the trial's fixed "now") plus a sequence number. No wall clock, no Math.random.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitproto.ts';

export const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_ID = 1000;
export const STRANGER_LOGIN = 'olgabauer';

export const FORGE_IDENTITY = 'Plenger Forge <forge@plenger.invalid>';

/** The trial's fixed "now", seconds since epoch. Falls back to 2025-01-01. */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) {
      // Accept seconds or milliseconds.
      return asNum > 1e12 ? Math.floor(asNum / 1000) : Math.floor(asNum);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1735689600;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
  authorLogin: string;
}

export interface Issue {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  updatedSeq: number;
  closedSeq: number | null;
  comments: Comment[];
}

export interface Pull {
  dbId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
}

export interface MergeResult {
  treeOid: string | null;
  conflicts: string[];
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'already-merged' | 'no-base' | 'no-head' };

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  readonly nowSec: number;
  private seq = 0;
  private nextRepoId = 1;
  private nextDbId = 1;
  private nextCommentId = 1;

  constructor(nowSec?: number) {
    this.nowSec = nowSec ?? trialNowSec();
  }

  /** A strictly increasing sequence number, used for creation order and timestamps. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** ISO-8601 timestamp for sequence `seq` (deterministic: trial now + seq seconds). */
  private isoCache = new Map<number, string>();
  isoAt(seq: number): string {
    const cached = this.isoCache.get(seq);
    if (cached !== undefined) return cached;
    const value = new Date((this.nowSec + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    this.isoCache.set(seq, value);
    return value;
  }

  // -----------------------------------------------------------------------------------------
  // objects
  // -----------------------------------------------------------------------------------------

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // -----------------------------------------------------------------------------------------
  // repositories
  // -----------------------------------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      isPrivate,
      description,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextNumber: 1,
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // git: refs, trees, commits
  // -----------------------------------------------------------------------------------------

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, full ref or oid to a commit oid (null when unresolvable). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isOid(ref)) {
      const object = this.objects.get(ref);
      if (!object) return null;
      return peelToCommit(ref, (oid) => this.objects.get(oid));
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const tip = repo.refs.get(full);
    if (tip === undefined) return null;
    return peelToCommit(tip, (oid) => this.objects.get(oid));
  }

  /** The tree oid at a commit, or the empty tree when the repo is unborn. */
  treeAt(repo: Repo, ref: string): string {
    const commitOid = this.resolveRef(repo, ref);
    if (commitOid === null) return this.emptyTreeOid();
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return this.emptyTreeOid();
    return parseCommit(commit.data).tree;
  }

  private emptyTree: string | null = null;

  emptyTreeOid(): string {
    if (this.emptyTree === null) this.emptyTree = this.putObject('tree', buildTree([]));
    return this.emptyTree;
  }

  /** Flatten a tree (recursively) into path -> {mode, oid}. */
  flattenTree(treeOid: string): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) a tree from a flat path map. */
  buildTreeFromMap(files: Map<string, TreeEntry>): string {
    interface Node {
      files: Map<string, TreeEntry>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const entry of node.files.values()) entries.push(entry);
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object on top of `parentOids` with `treeOid`; returns its oid. */
  makeCommit(treeOid: string, parentOids: readonly string[], message: string): string {
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const data = buildCommit({
      tree: treeOid,
      parents: parentOids,
      message: msg,
      author: FORGE_IDENTITY,
      timestamp: this.nowSec,
    });
    return this.putObject('commit', data);
  }

  /** The first common ancestor of two commits (histories here are linear; BFS is enough). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const queueA: string[] = [a];
    while (queueA.length) {
      const oid = queueA.pop()!;
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    const queueB: string[] = [b];
    const seenB = new Set<string>();
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    return null;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** All commit oids reachable from `tip`, newest-first by BFS depth (parents after children). */
  walkCommits(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  // -----------------------------------------------------------------------------------------
  // three-way merge + diff (for squash merges and pull-request files)
  // -----------------------------------------------------------------------------------------

  /**
   * Three-way merge of file maps: base (merge-base), head (the PR branch), target (the
   * base branch tip). Returns the merged tree oid, or null + conflict paths when the same
   * file changed differently on both sides.
   */
  threeWayMerge(baseTree: string, headTree: string, targetTree: string): MergeResult {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const target = this.flattenTree(targetTree);
    const conflicts: string[] = [];
    const merged = new Map<string, TreeEntry>(target);
    const paths = new Set<string>([...base.keys(), ...head.keys(), ...target.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const t = target.get(path);
      const bOid = b?.oid ?? null;
      const hOid = h?.oid ?? null;
      const tOid = t?.oid ?? null;
      if (hOid === bOid) {
        // Head unchanged: keep target (already in merged).
        continue;
      }
      if (tOid === bOid) {
        // Target unchanged: take head.
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
        continue;
      }
      if (hOid === tOid) continue; // Both changed to the same thing.
      conflicts.push(path);
    }
    if (conflicts.length) return { treeOid: null, conflicts };
    return { treeOid: this.buildTreeFromMap(merged), conflicts: [] };
  }

  /** Files changed between two trees: path -> {status, oldOid, newOid}. */
  diffTrees(baseTree: string, headTree: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === undefined && h !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b !== undefined && h === undefined) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (b !== undefined && h !== undefined && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }

  /** Line counts for a changed file (a small LCS diff; files in the suite are small). */
  lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const a = oldText === '' ? [] : oldText.split('\n');
    const b = newText === '' ? [] : newText.split('\n');
    // Drop a single trailing empty element produced by a trailing newline.
    if (a.length && a[a.length - 1] === '') a.pop();
    if (b.length && b[b.length - 1] === '') b.pop();
    const n = a.length;
    const m = b.length;
    if (n === 0) return { additions: m, deletions: 0 };
    if (m === 0) return { additions: 0, deletions: n };
    // LCS lengths, two rows.
    let prev = new Array<number>(m + 1).fill(0);
    let cur = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      [prev, cur] = [cur, prev];
    }
    const lcs = prev[m];
    return { additions: m - lcs, deletions: n - lcs };
  }

  blobText(oid: string | null): string {
    if (oid === null) return '';
    const object = this.objects.get(oid);
    if (!object || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  // -----------------------------------------------------------------------------------------
  // issues, pull requests, labels, comments
  // -----------------------------------------------------------------------------------------

  nextNumber(repo: Repo): number {
    const n = repo.nextNumber;
    repo.nextNumber += 1;
    return n;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = this.nextSeq();
    const issue: Issue = {
      dbId: this.nextDbId++,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: seq,
      updatedSeq: seq,
      closedSeq: null,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const seq = this.nextSeq();
    const pull: Pull = {
      dbId: this.nextDbId++,
      number: this.nextNumber(repo),
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      mergedSeq: null,
      mergeSha: null,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.pulls.push(pull);
    return pull;
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  createComment(issue: Issue, body: string, authorLogin: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, createdSeq: this.nextSeq(), authorLogin };
    issue.comments.push(comment);
    return comment;
  }

  /** Global (Relay) ids: opaque base64, stable across reads. */
  private globalIdCache = new Map<string, string>();
  globalId(kind: string, id: number): string {
    const key = `${kind}:${id}`;
    const cached = this.globalIdCache.get(key);
    if (cached !== undefined) return cached;
    const value = Buffer.from(key, 'utf8').toString('base64');
    this.globalIdCache.set(key, value);
    return value;
  }

  parseGlobalId(id: string): { kind: string; id: number } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const match = /^([A-Za-z]+):(\d+)$/.exec(text);
      if (!match) return null;
      return { kind: match[1]!, id: Number(match[2]) };
    } catch {
      return null;
    }
  }

  findRepoByDbId(dbId: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === dbId) return repo;
    return undefined;
  }

  findIssueByDbId(dbId: number): { repo: Repo; issue: Issue } | undefined {
    for (const repo of this.repos.values()) {
      const issue = repo.issues.find((entry) => entry.dbId === dbId);
      if (issue) return { repo, issue };
    }
    return undefined;
  }

  findPullByDbId(dbId: number): { repo: Repo; pull: Pull } | undefined {
    for (const repo of this.repos.values()) {
      const pull = repo.pulls.find((entry) => entry.dbId === dbId);
      if (pull) return { repo, pull };
    }
    return undefined;
  }

  // -----------------------------------------------------------------------------------------
  // squash merge (shared by REST and GraphQL and MCP)
  // -----------------------------------------------------------------------------------------

  /**
   * Squash-merge an open pull request onto its base branch. Creates one commit on the
   * base branch whose tree is the three-way merge of merge-base/head/base-tip.
   */
  squashMerge(repo: Repo, pull: Pull): MergeOutcome {
    if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'already-merged' };
    const baseTip = this.resolveRef(repo, pull.base);
    const headTip = this.resolveRef(repo, pull.head);
    if (baseTip === null) return { ok: false, reason: 'no-base' };
    if (headTip === null) return { ok: false, reason: 'no-head' };
    const baseCommit = this.objects.get(baseTip);
    const headCommit = this.objects.get(headTip);
    if (!baseCommit || !headCommit) return { ok: false, reason: 'no-head' };
    const mergeBaseOid = this.mergeBase(baseTip, headTip);
    const baseTree = mergeBaseOid === null ? this.emptyTreeOid() : parseCommit(this.objects.get(mergeBaseOid)!.data).tree;
    const merged = this.threeWayMerge(baseTree, parseCommit(headCommit.data).tree, parseCommit(baseCommit.data).tree);
    if (merged.treeOid === null) return { ok: false, reason: 'conflict' };
    const seq = this.nextSeq();
    const sha = this.makeCommit(merged.treeOid, [baseTip], `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedSeq = seq;
    pull.mergeSha = sha;
    pull.updatedSeq = seq;
    return { ok: true, sha };
  }

  /** MERGEABLE / CONFLICTING for a pull request (UNKNOWN when a branch is missing). */
  mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.merged) return 'MERGEABLE';
    const baseTip = this.resolveRef(repo, pull.base);
    const headTip = this.resolveRef(repo, pull.head);
    if (baseTip === null || headTip === null) return 'UNKNOWN';
    const baseCommit = this.objects.get(baseTip);
    const headCommit = this.objects.get(headTip);
    if (!baseCommit || !headCommit) return 'UNKNOWN';
    const mergeBaseOid = this.mergeBase(baseTip, headTip);
    const baseTree = mergeBaseOid === null ? this.emptyTreeOid() : parseCommit(this.objects.get(mergeBaseOid)!.data).tree;
    const merged = this.threeWayMerge(baseTree, parseCommit(headCommit.data).tree, parseCommit(baseCommit.data).tree);
    return merged.treeOid === null ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** The changed files of a pull request (merge-base tree vs head tip tree). */
  pullFiles(repo: Repo, pull: Pull): Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const baseTip = this.resolveRef(repo, pull.base);
    const headTip = this.resolveRef(repo, pull.head);
    if (baseTip === null || headTip === null) return [];
    const baseCommit = this.objects.get(baseTip);
    const headCommit = this.objects.get(headTip);
    if (!baseCommit || !headCommit) return [];
    const mergeBaseOid = this.mergeBase(baseTip, headTip);
    const baseTree = mergeBaseOid === null ? this.emptyTreeOid() : parseCommit(this.objects.get(mergeBaseOid)!.data).tree;
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    for (const change of this.diffTrees(baseTree, parseCommit(headCommit.data).tree)) {
      const { additions, deletions } = this.lineDiff(this.blobText(change.oldOid), this.blobText(change.newOid));
      out.push({ path: change.path, status: change.status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }
}
