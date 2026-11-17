// git.ts — git smart HTTP: info/refs advertisements, upload-pack (v2 and
// v0) and receive-pack (v0 only), speaking the pkt-line protocol by hand.
//
// The client decides v2 versus v0 by the Git-Protocol header on info/refs:
// present means v2 for upload-pack; receive-pack never carries it, so it is
// always v0. A missing repository is a 404 on both services and the server
// stays up afterwards.

import {
  ZERO_OID,
  buildTree,
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObject,
  readPack,
  writePack,
  PKT_FLUSH,
  pktLine,
  type GitObject,
} from './objects.ts';
import { VIEWER_LOGIN } from './store.ts';
import type { Repo, Store } from './store.ts';

/** What a handler answers: status, content type and raw bytes. */
export interface GitAnswer {
  status: number;
  contentType: string;
  body: Buffer;
}

function textAnswer(status: number, message: string): GitAnswer {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

/** The repository the git path names, or null (unknown owner, name or repo). */
function lookupRepo(store: Store, owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.repo(owner, repoName);
}

/** All refs of a repository, HEAD first, then heads, then tags, sorted. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined) refs.push({ name: 'HEAD', oid: tip });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) refs.push({ name, oid: repo.refs.get(name)! });
  return refs;
}

/** The commit an annotated tag peels to, or null. */
function peeledCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelToCommit(repo.objects, parseTag(object.data).object);
}

/** The v0 capability list for upload-pack, on the first ref line. */
function uploadPackCapsV0(repo: Repo): string {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const symref = tip === undefined ? '' : ` symref=HEAD:refs/heads/${repo.defaultBranch}`;
  return `side-band-64k shallow thin-pack ofs-delta${symref}`;
}

/** The v0 capability list for receive-pack, on the first ref line. */
function receivePackCapsV0(repo: Repo): string {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const symref = tip === undefined ? '' : ` symref=HEAD:refs/heads/${repo.defaultBranch}`;
  return `report-status side-band-64k delete-refs ofs-delta${symref}`;
}

/** One v0 ref line, with capabilities after NUL when `caps` is given. */
function refLine(name: string, oid: string, caps?: string): Buffer {
  return pktLine(caps === undefined ? `${oid} ${name}\n` : `${oid} ${name}\0${caps}\n`);
}

/** The v0 advertisement body for a service, with its "# service=" preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0(repo) : receivePackCapsV0(repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(refLine('capabilities^{}', ZERO_OID, caps));
    return Buffer.concat(parts);
  }
  let first = true;
  for (const ref of refs) {
    parts.push(refLine(ref.name, ref.oid, first ? caps : undefined));
    first = false;
    if (ref.name.startsWith('refs/tags/')) {
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled !== null) parts.push(refLine(`${ref.name}^{}`, peeled));
    }
  }
  return Buffer.concat(parts);
}

/** The v2 capability advertisement body (no service preamble). */
function v2Advertisement(): Buffer {
  return encodePktLines(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'flush']);
}

// ---------------------------------------------------------------- info/refs

/** GET /<owner>/<repo>.git/info/refs?service=<service>. */
export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string | null,
  gitProtocol: string | null,
): GitAnswer {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return textAnswer(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return textAnswer(400, 'a service parameter is required');
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  /** The objects to send, as full objects (tag objects included when wanted). */
  send: GitObject[];
  /** New shallow boundary commits (depth cutoffs not already held). */
  shallow: string[];
  /** Old client boundaries that are interior now. */
  unshallow: string[];
}

/**
 * The closure of the client's haves, truncated at its shallow boundaries:
 * a shallow commit is held with its whole tree, but its parents are not —
 * the client stopped there. (A plain closure would claim the parents too,
 * and a deepen fetch would send nothing new.)
 */
function haveClosure(objects: Map<string, GitObject>, haves: readonly string[], shallow: readonly string[]): Set<string> {
  const shallowSet = new Set(shallow);
  const seen = new Set<string>();
  const visitTree = (treeOid: string): void => {
    if (seen.has(treeOid)) return;
    const tree = objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    seen.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') visitTree(entry.oid);
      else seen.add(entry.oid);
    }
  };
  const visitCommit = (oid: string): void => {
    if (seen.has(oid)) return;
    const commit = objects.get(oid);
    if (commit === undefined || commit.type !== 'commit') return;
    seen.add(oid);
    const meta = parseCommit(commit.data);
    visitTree(meta.tree);
    if (shallowSet.has(oid)) return;
    for (const parent of meta.parents) visitCommit(parent);
  };
  for (const have of haves) {
    const object = objects.get(have);
    if (object === undefined) continue;
    if (object.type === 'commit') visitCommit(have);
    else if (object.type === 'tag') {
      seen.add(have);
      const peeled = peelToCommit(objects, have);
      if (peeled !== null) visitCommit(peeled);
    } else if (object.type === 'tree') visitTree(have);
    else seen.add(have);
  }
  return seen;
}

/** Which objects a fetch transfers, honouring haves, depth and shallow boundaries. */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const objects = repo.objects;
  // The objects the client already holds: the closure of its haves, but never
  // past a shallow boundary — a shallow commit's parents are precisely what
  // the client does NOT have, and a deepen fetch must deliver them.
  const haveSet = haveClosure(objects, request.haves, request.shallow);
  const included = new Set<string>();
  const boundary = new Set<string>();
  const wantedTags: string[] = [];
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const want of request.wants) {
    const object = objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantedTags.push(want);
      const peeled = peelToCommit(objects, want);
      if (peeled !== null) queue.push({ oid: peeled, generation: 0 });
      continue;
    }
    if (object.type === 'commit') queue.push({ oid: want, generation: 0 });
    else included.add(want);
  }
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (seenCommits.has(item.oid)) continue;
    seenCommits.add(item.oid);
    if (request.depth !== null && item.generation >= request.depth) continue;
    included.add(item.oid);
    if (request.depth !== null && item.generation === request.depth - 1) boundary.add(item.oid);
    const object = objects.get(item.oid);
    if (object === undefined || object.type !== 'commit') continue;
    const meta = parseCommit(object.data);
    for (const parent of meta.parents) queue.push({ oid: parent, generation: item.generation + 1 });
  }
  // Every included commit brings its whole tree.
  const treeStack: string[] = [];
  for (const oid of [...included]) {
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit') treeStack.push(parseCommit(object.data).tree);
  }
  const treeSeen = new Set<string>();
  while (treeStack.length > 0) {
    const treeOid = treeStack.pop()!;
    if (treeSeen.has(treeOid)) continue;
    treeSeen.add(treeOid);
    included.add(treeOid);
    const tree = objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') continue;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') treeStack.push(entry.oid);
      else included.add(entry.oid);
    }
  }
  for (const tag of wantedTags) included.add(tag);
  const send: GitObject[] = [];
  for (const oid of [...included].sort()) {
    if (haveSet.has(oid)) continue;
    const object = objects.get(oid);
    if (object !== undefined) send.push(object);
  }
  const shallow = [...boundary].filter((oid) => !haveSet.has(oid)).sort();
  const unshallow: string[] = [];
  for (const old of request.shallow) {
    if (!seenCommits.has(old)) continue;
    const object = objects.get(old);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => seenCommits.has(parent))) unshallow.push(old);
  }
  return { send, shallow, unshallow: unshallow.sort() };
}

/** A pack cache: the same fetch (same wants, depth, haves) builds one pack. */
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 64;

function cachedPack(repo: Repo, request: FetchRequest, plan: FetchPlan): Buffer {
  const key = [
    repo.id,
    [...request.wants].sort().join(','),
    request.depth === null ? '' : String(request.depth),
    [...request.haves].sort().join(','),
    [...request.shallow].sort().join(','),
  ].join('|');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(plan.send);
  if (packCache.size >= PACK_CACHE_MAX) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

/** Wrap pack bytes in sideband band-1 pkt-lines (each at most 65500 data bytes). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const banded = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(banded));
  }
  return parts;
}

/** The v2 ls-refs answer. */
function lsRefsV2(repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined && (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix)))) {
    const attrs = symrefs ? ' symref-target:refs/heads/main' : '';
    parts.push(pktLine(`${tip} HEAD${attrs}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peeledCommit(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse the pkt-line body of an upload-pack POST into command lines and control packets. */
function parseUploadBody(body: Buffer): { kind: 'v2-ls-refs' | 'v2-fetch' | 'v0-fetch'; args: string[] } | null {
  let lines: ReturnType<typeof decodePktLines>;
  try {
    lines = decodePktLines(body);
  } catch {
    return null;
  }
  const texts: string[] = [];
  let delimIndex = -1;
  for (const line of lines) {
    if (line.kind === 'delim') {
      if (delimIndex < 0) delimIndex = texts.length;
    } else if (line.kind === 'data') {
      texts.push(line.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  if (texts.length === 0) return null;
  const first = texts[0]!;
  if (first.startsWith('command=ls-refs')) {
    // The arguments follow the delim; without one, everything after the command line.
    const args = delimIndex >= 0 ? texts.slice(delimIndex) : texts.slice(1).filter((text) => text !== 'command=ls-refs');
    return { kind: 'v2-ls-refs', args };
  }
  if (first.startsWith('command=fetch')) {
    return { kind: 'v2-fetch', args: texts.slice(1) };
  }
  if (first.startsWith('want ')) {
    return { kind: 'v0-fetch', args: texts };
  }
  return null;
}

/** POST /<owner>/<repo>.git/git-upload-pack. */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): GitAnswer {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return textAnswer(404, 'Not Found');
  const parsed = parseUploadBody(body);
  if (parsed === null) return textAnswer(400, 'the request body is not a pkt-line stream');
  const resultType = 'application/x-git-upload-pack-result';

  if (parsed.kind === 'v2-ls-refs') {
    return { status: 200, contentType: resultType, body: lsRefsV2(repo, parsed.args) };
  }

  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of parsed.args) {
    const line = arg.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) request.depth = depth;
    }
  }
  request.wants = request.wants.filter(isOid);
  request.haves = request.haves.filter(isOid);
  request.shallow = request.shallow.filter(isOid);
  const plan = planFetch(repo, request);

  if (parsed.kind === 'v2-fetch') {
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
    if (plan.send.length === 0) return { status: 200, contentType: resultType, body: Buffer.concat(parts) };
    if (request.depth !== null && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(pktLine('packfile\n'));
    for (const packet of sidebandPackets(cachedPack(repo, request, plan))) parts.push(packet);
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: resultType, body: Buffer.concat(parts) };
  }

  // v0 fetch: "NAK" (or ACKs), shallow lines, then sideband packets directly.
  const parts: Buffer[] = [pktLine('NAK\n')];
  if (plan.send.length === 0) return { status: 200, contentType: resultType, body: Buffer.concat(parts) };
  if (request.depth !== null) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  for (const packet of sidebandPackets(cachedPack(repo, request, plan))) parts.push(packet);
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: resultType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack body into its command lines and its pack bytes. */
function splitReceiveBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } | null {
  const commands: PushCommand[] = [];
  let offset = 0;
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    const text = body.subarray(offset, offset + 4).toString('ascii');
    if (text === '0000') {
      sawFlush = true;
      offset += 4;
      break;
    }
    const length = parseInt(text, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > body.length) return null;
    let line = body.subarray(offset + 4, offset + length).toString('utf8');
    offset += length;
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match === null) return null;
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (!sawFlush) return null;
  return { commands, pack: body.subarray(offset) };
}

/** POST /<owner>/<repo>.git/git-receive-pack. */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitAnswer {
  const repo = lookupRepo(store, owner, repoName);
  if (repo === null) return textAnswer(404, 'Not Found');
  const resultType = 'application/x-git-receive-pack-result';
  const split = splitReceiveBody(body);
  const report = (unpackOk: boolean, unpackDetail: string, lines: string[]): GitAnswer => {
    const parts: Buffer[] = [];
    const text = [`unpack ${unpackOk ? 'ok' : unpackDetail}`, ...lines].join('\n') + '\n';
    for (const line of text.split('\n').filter((entry) => entry !== '')) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.from(`${line}\n`, 'utf8')])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: resultType, body: Buffer.concat(parts) };
  };
  if (split === null || split.commands.length === 0) return textAnswer(400, 'the request body is not a receive-pack command list');
  let incoming = new Map<string, GitObject>();
  if (split.pack.length > 0) {
    try {
      incoming = readPack(split.pack);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unpack failed';
      return report(false, detail, split.commands.map((command) => `ng ${command.ref} unpack failed`));
    }
  }
  for (const [oid, object] of incoming) {
    if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  }
  const lines: string[] = [];
  for (const command of split.commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        lines.push(`ng ${command.ref} remote ref does not exist`);
        continue;
      }
      repo.refs.delete(command.ref);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      lines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        lines.push(`ng ${command.ref} already exists`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (current === undefined) {
      lines.push(`ng ${command.ref} remote ref does not exist`);
      continue;
    }
    if (current !== command.oldOid) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    const peeledOld = peelToCommit(repo.objects, current) ?? current;
    const peeledNew = peelToCommit(repo.objects, command.newOid) ?? command.newOid;
    if (peeledOld !== peeledNew && !isAncestor(repo.objects, peeledOld, peeledNew)) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  return report(true, 'ok', lines);
}

/** The empty tree's id (a convenience for contents writes on a fresh repo). */
export function emptyTreeOid(): string {
  return hashObject('tree', buildTree([]));
}

export { putObject };
