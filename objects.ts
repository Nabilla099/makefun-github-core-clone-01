// objects.ts — the git object layer: SHA-1 ids, commits, trees, tags,
// packfiles, pkt-lines, reachability, diffs and three-way merges.
//
// Everything here is pure computation over Buffers and Maps. No I/O, no
// clock, no randomness: the same inputs always produce the same bytes,
// which is what makes a replay of the same requests behave identically.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The four object kinds git knows. */
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored object: its kind and its exact bytes. */
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** The SHA-1 of "<type> <size>\0" followed by the bytes. */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Store one object in `objects` and answer its id (idempotent). */
export function putObject(objects: Map<string, GitObject>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

/** Whether `text` is a 40-hex object id. */
export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

// ---------------------------------------------------------------- commits

export interface CommitMeta {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Split a commit's bytes into its header fields and its message. */
export function parseCommit(data: Buffer): CommitMeta {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit's bytes. `message` is used as given (callers end it with \n). */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  timestamp: number;
  author: string;
  committer: string;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  lines.push('');
  lines.push(input.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** git's sort: entries compare by name, directories as if ending in '/'. */
export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Build a tree's bytes from its entries (sorted git-style). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Split a tree's bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- tags

export interface TagMeta {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Split an annotated tag's bytes into its header fields and message. */
export function parseTag(data: Buffer): TagMeta {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build an annotated tag's bytes. */
export function buildTag(input: { object: string; type: ObjType; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger} ${input.timestamp} +0000`,
    '',
    input.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------- pkt-lines

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

/** One parsed pkt-line. `raw` is the whole line including its 4-byte length. */
export interface PktLine {
  kind: PktKind;
  payload: Buffer;
  raw: Buffer;
}

/** Encode one pkt-line: 4 hex digits of length (header included) + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet, "0000". */
export const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
/** The delim packet, "0001". */
export const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

/** Decode a whole buffer of pkt-lines. Throws on a malformed line. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header is truncated');
    const text = buffer.subarray(offset, offset + 4).toString('ascii');
    if (text === '0000') {
      lines.push({ kind: 'flush', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (text === '0001') {
      lines.push({ kind: 'delim', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    if (text === '0002') {
      lines.push({ kind: 'response-end', payload: Buffer.alloc(0), raw: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    const length = parseInt(text, 16);
    if (!Number.isFinite(length) || length < 4 || offset + length > buffer.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(text)}`);
    }
    lines.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length), raw: buffer.subarray(offset, offset + length) });
    offset += length;
  }
  return lines;
}

/** Encode a list of lines and control packets into one buffer. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The pack header for one object: varint type + size, then its zlib stream. */
function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = PACK_TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (remaining & 0x0f) | (code << 4);
  remaining >>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let next = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Build a packfile (version 2, plain objects, no deltas) from objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream out of `buffer` starting at `offset`: the smallest
 *  length that inflates cleanly is the stream's end (a shorter slice throws
 *  "unexpected end of file"; inflateSync ignores bytes past the stream). */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; end: number } {
  let low = offset + 1;
  let high = buffer.length;
  // A stream always ends before the 20-byte trailer; bound the search there.
  high = Math.min(high, buffer.length);
  let found = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buffer.subarray(offset, mid));
      found = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (found < 0) throw new Error('pack entry has no complete zlib stream');
  return { data: inflateSync(buffer.subarray(offset, found)), end: found };
}

/** Read a packfile into its objects. Plain entries only; a delta entry is an error. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== expected) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset >= trailerStart) throw new Error('pack ends before its declared count');
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack object header is truncated');
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = PACK_CODE_TYPES[typeCode];
    if (type === undefined) throw new Error(`pack entry has unsupported type code ${typeCode}`);
    const { data, end } = inflateAt(pack, offset);
    if (data.length !== size) throw new Error('pack entry size does not match its header');
    offset = end;
    const oid = hashObject(type, data);
    if (!objects.has(oid)) objects.set(oid, { type, data });
  }
  return objects;
}

// ---------------------------------------------------------------- reachability

/** The object a ref tip names, peeling an annotated tag to its target commit. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All objects reachable from `roots` (commits, their trees and blobs), walking parents. */
export function closure(objects: Map<string, GitObject>, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
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
    const commit = objects.get(oid);
    if (commit === undefined || commit.type !== 'commit') return;
    if (seen.has(oid)) return;
    seen.add(oid);
    const meta = parseCommit(commit.data);
    visitTree(meta.tree);
    for (const parent of meta.parents) visitCommit(parent);
  };
  for (const root of roots) {
    const object = objects.get(root);
    if (object === undefined) continue;
    if (object.type === 'commit') visitCommit(root);
    else if (object.type === 'tag') {
      seen.add(root);
      const target = parseTag(object.data).object;
      const peeled = peelToCommit(objects, target);
      if (peeled !== null) visitCommit(peeled);
      else if (objects.has(target)) seen.add(target);
    } else if (object.type === 'tree') visitTree(root);
    else seen.add(root);
  }
  // Roots themselves count even when they hold no reachable graph (a lone blob).
  for (const root of roots) if (objects.has(root)) seen.add(root);
  return seen;
}

/** Whether `ancestor` is reachable from `commit` (walking parents). */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>();
  const stack = [commit];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The nearest common ancestor of two commits (or null when their histories never meet). */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    if (ancestors.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stackB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- trees as maps

/** A tree flattened to path -> {mode, oid}, recursively. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, base: string): void => {
    const tree = objects.get(oid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build nested tree objects from a flat path map, storing them in `objects`. */
export function buildTreeFromMap(objects: Map<string, GitObject>, flat: Map<string, { mode: string; oid: string }>): string {
  const buildDir = (dir: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, value] of flat) {
      if (!path.startsWith(dir)) continue;
      const rest = dir === '' ? path : path.slice(dir.length + 1);
      if (rest === '') continue;
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: value.mode, name: rest, oid: value.oid });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const sub of subdirs) {
      entries.push({ mode: '40000', name: sub, oid: buildDir(dir === '' ? sub : `${dir}/${sub}`) });
    }
    return putObject(objects, 'tree', buildTree(entries));
  };
  return buildDir('');
}

/** The number of lines in a blob's bytes (a trailing newline ends the last line). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** The file-level diff between two trees (empty tree when the oid is null). */
export function treeDiff(
  objects: Map<string, GitObject>,
  oldTree: string | null,
  newTree: string | null,
): FileChange[] {
  const oldMap = oldTree === null ? new Map() : flattenTree(objects, oldTree);
  const newMap = newTree === null ? new Map() : flattenTree(objects, newTree);
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry !== undefined && newEntry !== undefined) {
      if (oldEntry.oid === newEntry.oid) continue;
      const oldBlob = objects.get(oldEntry.oid);
      const newBlob = objects.get(newEntry.oid);
      changes.push({
        path,
        status: 'modified',
        oldOid: oldEntry.oid,
        newOid: newEntry.oid,
        additions: newBlob === undefined ? 0 : lineCount(newBlob.data),
        deletions: oldBlob === undefined ? 0 : lineCount(oldBlob.data),
      });
    } else if (newEntry !== undefined) {
      const newBlob = objects.get(newEntry.oid);
      changes.push({
        path,
        status: 'added',
        oldOid: null,
        newOid: newEntry.oid,
        additions: newBlob === undefined ? 0 : lineCount(newBlob.data),
        deletions: 0,
      });
    } else if (oldEntry !== undefined) {
      const oldBlob = objects.get(oldEntry.oid);
      changes.push({
        path,
        status: 'deleted',
        oldOid: oldEntry.oid,
        newOid: null,
        additions: 0,
        deletions: oldBlob === undefined ? 0 : lineCount(oldBlob.data),
      });
    }
  }
  return changes;
}

export interface MergeOutcome {
  /** The merged tree's oid, or null when the merge conflicts. */
  tree: string | null;
  /** Paths that changed differently on both sides. */
  conflicts: string[];
}

/**
 * A three-way merge of `headTree` onto `baseTipTree`, with `baseTree` as the
 * common ancestor. A path changed on one side only takes that side's version;
 * a path changed the same way on both takes it once; anything else conflicts.
 */
export function threeWayMerge(
  objects: Map<string, GitObject>,
  baseTree: string,
  headTree: string,
  baseTipTree: string,
): MergeOutcome {
  const base = flattenTree(objects, baseTree);
  const head = flattenTree(objects, headTree);
  const tip = flattenTree(objects, baseTipTree);
  const merged = new Map<string, { mode: string; oid: string }>();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...head.keys(), ...tip.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const t = tip.get(path);
    const headChanged = (b?.oid ?? null) !== (h?.oid ?? null);
    const tipChanged = (b?.oid ?? null) !== (t?.oid ?? null);
    if (!headChanged && !tipChanged) {
      if (b !== undefined) merged.set(path, b);
    } else if (headChanged && !tipChanged) {
      if (h !== undefined) merged.set(path, h);
    } else if (!headChanged && tipChanged) {
      if (t !== undefined) merged.set(path, t);
    } else if ((h?.oid ?? null) === (t?.oid ?? null)) {
      if (h !== undefined) merged.set(path, h);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { tree: null, conflicts: conflicts.sort() };
  return { tree: buildTreeFromMap(objects, merged), conflicts: [] };
}
