// githttp.ts — git smart HTTP: the /{owner}/{repo}.git surface.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   (v2 when the request
//        carries Git-Protocol: version=2, else v0)
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  (v0 only)
//   POST /{owner}/{repo}.git/git-upload-pack                     (v2 ls-refs / fetch, v0 fetch)
//   POST /{owner}/{repo}.git/git-receive-pack                    (v0, report-status + side-band-64k)
//
// Packs the server sends carry plain objects (no deltas); the client resolves deltas
// when it sends them. Sideband packets are chunked so no pkt-line exceeds 65520 bytes.

import {
  decodePktLines,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  pktLines,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjectLookup,
  type PktItem,
} from './gitproto.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';

export const AGENT = 'plenger-forge/1.0.0';

const MAX_SIDEBAND_DATA = 65515; // 65520 pkt-line max - 4 header - 1 band byte

export interface GitContext {
  store: Store;
  owner: string;
  repoName: string;
  repo: Repo;
}

/** Look a repository up by owner/name; null when absent or not the viewer's. */
export function lookupGitRepo(store: Store, owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repoName) ?? null;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, sorted by name, with HEAD first where applicable. */
function listRefs(store: Store, repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headTarget);
  out.push({
    oid: headTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: headTarget,
    unborn: headTip === undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    const object = store.getObject(oid);
    if (object?.type === 'tag') {
      const peeled = peelToCommit(oid, (id) => store.getObject(id));
      if (peeled !== null) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

const UPLOAD_V2_CAPS = `ls-refs=unborn\nfetch=shallow wait-for-done\nagent=${AGENT}\nobject-format=sha1\n`;

function v2Advertisement(): Buffer {
  return pktLines([`version 2\n`, ...UPLOAD_V2_CAPS.split('\n').filter((line) => line !== '').map((line) => `${line}\n`), 'flush']);
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const refs = listRefs(store, repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (repo.refs.size === 0) {
    // An empty repo advertises no refs at all: the zero id with the
    // capabilities^{} pseudo-ref carries the capability list.
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const head = refs[0]!;
    lines.push(`${head.oid} HEAD\0${caps}\n`);
    for (const ref of refs.slice(1)) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

export function infoRefs(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): { contentType: string; body: Buffer } {
  if (service === 'git-upload-pack' && protocolV2) {
    return { contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(store, repo, service),
  };
}

// -------------------------------------------------------------------------------------------
// fetch planning
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * The object closure of a fetch: trees and blobs under the seeded commits, plus tag
 * targets. When `limited` (a depth was requested) parents are never followed, so the
 * closure stops at the depth boundary; without a limit the whole history is walked.
 */
function collectFetchClosure(
  seeds: Iterable<string>,
  includedCommits: Set<string>,
  tagTargets: Set<string>,
  lookup: ObjectLookup,
  limited: boolean,
): Set<string> {
  const out = new Set<string>();
  const queue: string[] = [...seeds];
  while (queue.length) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (!limited || includedCommits.has(oid) || tagTargets.has(oid)) queue.push(commit.tree);
      if (!limited) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return out;
}

/**
 * What the client already holds, from its `have` lines: the full closure of each
 * have, except that a shallow boundary (named by the client's `shallow` lines) is
 * held without its parents — a shallow clone has the boundary commit and its tree,
 * but none of the history behind it. Crossing the boundary would wrongly conclude
 * the client already has the parent, and a deepen would then send nothing.
 */
function collectHaveClosure(haves: string[], shallowIn: string[], lookup: ObjectLookup): Set<string> {
  const shallowSet = new Set(shallowIn);
  const out = new Set<string>();
  const queue: string[] = [...haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return out;
}

function planFetch(
  store: Store,
  wants: string[],
  haves: string[],
  shallowIn: string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => store.getObject(oid);
  const haveClosure = collectHaveClosure(haves, shallowIn, lookup);

  // BFS over commits from the wants, tracking distance from the nearest want.
  const includedCommits = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  const seenWalk = new Set<string>();
  for (const want of wants) {
    const commitOid = peelToCommit(want, lookup);
    if (commitOid !== null) queue.push({ oid: commitOid, depth: 0 });
  }
  // Include wanted tag objects themselves.
  const wantedTags = new Set<string>();
  for (const want of wants) {
    const object = lookup(want);
    if (object?.type === 'tag') wantedTags.add(want);
  }
  while (queue.length) {
    const { oid, depth: d } = queue.shift()!;
    if (seenWalk.has(oid)) continue;
    seenWalk.add(oid);
    if (depth !== null && d >= depth) continue;
    includedCommits.add(oid);
    commitDepth.set(oid, d);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seenWalk.has(parent)) queue.push({ oid: parent, depth: d + 1 });
    }
  }

  // Boundary commits: included commits at the depth cutoff whose parents were cut off.
  const boundary = new Set<string>();
  if (depth !== null) {
    for (const oid of includedCommits) {
      if (commitDepth.get(oid) !== depth - 1) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      if (parents.some((parent) => !includedCommits.has(parent))) boundary.add(oid);
    }
  }

  // Shallow bookkeeping: old boundaries stay shallow unless now fully included.
  const shallow = new Set<string>(boundary);
  const unshallow: string[] = [];
  for (const old of shallowIn) {
    if (includedCommits.has(old)) {
      const object = lookup(old);
      const parents = object?.type === 'commit' ? parseCommit(object.data).parents : [];
      const complete = parents.every((parent) => includedCommits.has(parent) || haveClosure.has(parent));
      if (complete) unshallow.push(old);
      else shallow.add(old);
    } else {
      shallow.add(old);
    }
  }

  // Objects to send: the closure of the included commits and wanted tags, minus what
  // the client already holds. When a depth limit applies, the closure must NOT cross
  // it: only commits inside the depth window (and tag targets) contribute their
  // trees, and parents are never followed — otherwise a depth-1 clone silently
  // carries the whole history (collectReachable follows parents unconditionally).
  const limited = depth !== null;
  const tagTargets = new Set<string>();
  for (const tag of wantedTags) {
    const object = lookup(tag);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      if (lookup(target)?.type === 'commit') tagTargets.add(target);
    }
  }
  const closure = collectFetchClosure([...includedCommits, ...wantedTags], includedCommits, tagTargets, lookup, limited);
  const sendOids = new Set<string>();
  for (const oid of closure) {
    if (!haveClosure.has(oid)) sendOids.add(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of [...sendOids].sort()) {
    const object = lookup(oid);
    if (object) objects.push({ type: object.type, data: object.data });
  }

  // ACKs: haves the server holds that are ancestors of (or equal to) a want.
  const acks: string[] = [];
  for (const have of haves) {
    if (!isOid(have) || !lookup(have)) continue;
    const isWanted = wants.includes(have);
    let isAncestor = false;
    if (!isWanted) {
      for (const want of wants) {
        const commitOid = peelToCommit(want, lookup);
        if (commitOid !== null && store.isAncestor(have, commitOid)) { isAncestor = true; break; }
      }
    }
    if (isWanted || isAncestor) acks.push(have);
  }

  return { objects, shallow: [...shallow].sort(), unshallow: unshallow.sort(), acks };
}

/** Chunk bytes into sideband band-1 pkt-lines (each pkt-line <= 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += MAX_SIDEBAND_DATA) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX_SIDEBAND_DATA));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// upload-pack v2
// -------------------------------------------------------------------------------------------

function lsRefsV2(store: Store, repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const refs = listRefs(store, repo);
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn === true) {
      // Only HEAD is ever unborn, and only when the repo has no refs at all.
      lines.push(`unborn ${ref.name}${symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines);
}

function fetchV2(store: Store, args: string[]): Buffer {
  const wants = args.filter((arg) => arg.startsWith('want ')).map((arg) => arg.slice(5).trim());
  const haves = args.filter((arg) => arg.startsWith('have ')).map((arg) => arg.slice(5).trim());
  const shallowIn = args.filter((arg) => arg.startsWith('shallow ')).map((arg) => arg.slice(8).trim());
  const deepenLine = args.find((arg) => arg.startsWith('deepen '));
  const depth = deepenLine === undefined ? null : Number.parseInt(deepenLine.slice(7).trim(), 10);
  // `done` ends negotiation in this one request: the server must then skip the
  // acknowledgments section entirely and go straight to the packfile
  // (upload-pack.c: process_haves_and_send_acks returns early when done is set).
  // Every fetch the suite and git-over-HTTP send carries `done`, so the acks
  // section below only ever fires for a multi-round client without `done`.
  const done = args.includes('done');
  const plan = planFetch(store, wants, haves, shallowIn, Number.isFinite(depth) ? depth : null);

  const parts: Buffer[] = [];
  if (haves.length > 0 && !done) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('ready\n'));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  if (depth !== null || shallowIn.length > 0) {
    const info: Array<string | 'flush' | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) info.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) info.push(`unshallow ${oid}\n`);
    info.push('delim');
    parts.push(pktLines(info));
  }
  if (plan.objects.length) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(writePack(plan.objects)));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  return Buffer.concat(parts);
}

function fetchV0(store: Store, args: string[]): Buffer {
  const wants = args.filter((arg) => arg.startsWith('want ')).map((arg) => {
    const rest = arg.slice(5).trim();
    return rest.split(' ')[0]!;
  });
  const haves = args.filter((arg) => arg.startsWith('have ')).map((arg) => arg.slice(5).trim());
  const shallowIn = args.filter((arg) => arg.startsWith('shallow ')).map((arg) => arg.slice(8).trim());
  const deepenLine = args.find((arg) => arg.startsWith('deepen '));
  const depth = deepenLine === undefined ? null : Number.parseInt(deepenLine.slice(7).trim(), 10);
  const plan = planFetch(store, wants, haves, shallowIn, Number.isFinite(depth) ? depth : null);

  const parts: Buffer[] = [];
  if (plan.acks.length) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack. Throws on a malformed body. */
export function handleUploadPack(store: Store, repo: Repo, body: Buffer, protocolV2: boolean): { contentType: string; body: Buffer } {
  const contentType = 'application/x-git-upload-pack-result';
  if (!protocolV2) {
    // v0: want lines, flush, have lines, done, flush.
    const items = decodePktLines(body);
    const args: string[] = [];
    for (const item of items) {
      if (item.kind === 'data') args.push(item.payload.toString('utf8').replace(/\n$/, ''));
    }
    return { contentType, body: fetchV0(store, args) };
  }
  const items = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const item of items) {
    if (item.kind === 'delim') { seenDelim = true; continue; }
    if (item.kind !== 'data') continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  if (command === 'ls-refs') return { contentType, body: lsRefsV2(store, repo, args) };
  if (command === 'fetch') return { contentType, body: fetchV2(store, args) };
  throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
}

// -------------------------------------------------------------------------------------------
// receive-pack v0
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Handle POST /{owner}/{repo}.git/git-receive-pack. Returns the report-status stream
 * inside sideband band 1. Never throws for a well-formed-enough body: an unpack failure
 * is reported as `unpack error` and the ref updates are refused.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { contentType: string; body: Buffer } {
  const contentType = 'application/x-git-receive-pack-result';
  const reportLines: string[] = [];

  // Split the body into the pkt-line command section and the trailing pack bytes.
  const commands: PushCommand[] = [];
  let packBytes: Buffer | null = null;
  try {
    let off = 0;
    let sawFlush = false;
    while (off < body.length) {
      if (off + 4 > body.length) throw new Error('truncated pkt-line in push');
      const head = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('invalid pkt-line in push');
      const len = Number.parseInt(head, 16);
      if (len === 0) {
        off += 4;
        sawFlush = true;
        break;
      }
      if (len < 4 || off + len > body.length) throw new Error('truncated pkt-line in push');
      const payload = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
      const first = payload.split('\0')[0]!;
      const parts = first.split(' ');
      if (parts.length < 3) throw new Error(`bad push command ${JSON.stringify(first.slice(0, 60))}`);
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
      off += len;
    }
    if (!sawFlush) throw new Error('push body has no flush after its commands');
    packBytes = body.subarray(off);
  } catch (err) {
    reportLines.push('unpack error\n');
    for (const command of commands) reportLines.push(`ng ${command.ref} ${(err as Error).message}\n`);
    return { contentType, body: sidebandReport(reportLines) };
  }

  // Unpack: store every object, then evaluate the commands.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (updatesRef || (packBytes !== null && packBytes.length > 0)) {
    if (packBytes === null || packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'error: missing pack';
    } else {
      try {
        const read = readPack(packBytes);
        for (const [oid, object] of read.objects) {
          if (!store.getObject(oid)) store.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `error: ${(err as Error).message}`;
      }
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: unpackDetail });
  } else {
    for (const command of commands) {
      results.push(evaluatePush(store, repo, command));
    }
  }

  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  return { contentType, body: sidebandReport(reportLines) };
}

function sidebandReport(lines: string[]): Buffer {
  // The report is a pkt-line stream inside band 1, and like every pkt-line
  // stream it ends with its own flush *inside* the band: the client's report
  // reader reads pkt-lines until that flush, and only then does the outer
  // flush end the sideband stream itself (git receive-pack --stateless-rpc
  // emits exactly this shape). Without the inner flush the client reads the
  // report lines and then hangs waiting for the terminator.
  const inner = pktLines([...lines.map((line) => line as string), 'flush' as const]);
  const parts: Buffer[] = [];
  for (let off = 0; off < inner.length; off += MAX_SIDEBAND_DATA) {
    const chunk = inner.subarray(off, Math.min(inner.length, off + MAX_SIDEBAND_DATA));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function evaluatePush(store: Store, repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);

  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
    if (oldOid !== ZERO_OID && oldOid !== current) return { ref, ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }

  const object = store.getObject(newOid);
  if (!object) return { ref, ok: false, reason: 'failed to read object' };

  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }

  // Update: must fast-forward from the advertised tip.
  if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
  if (current !== oldOid) return { ref, ok: false, reason: 'non-fast-forward' };
  if (object.type === 'commit') {
    if (!store.isAncestor(oldOid, newOid)) return { ref, ok: false, reason: 'non-fast-forward' };
  } else if (object.type === 'tag') {
    const peeled = peelToCommit(newOid, (oid) => store.getObject(oid));
    if (peeled !== null && !store.isAncestor(oldOid, peeled)) return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

/** The ref advertisement a v0 client parses (used by push setup). */
export function refsForAdvertisement(store: Store, repo: Repo): Array<{ oid: string; name: string }> {
  return listRefs(store, repo).map((ref) => ({ oid: ref.oid, name: ref.name }));
}
