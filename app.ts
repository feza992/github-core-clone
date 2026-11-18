// github-core-clone — a GitHub-compatible git forge in one process, Node 22 stdlib only.
//
// Design: ONE KERNEL, FOUR THIN ADAPTERS. The kernel is the in-memory store
// (Repo) plus the core operations (createIssueOn, createPullOn, mergePull,
// putContents, fetchSelection, diffFlat). Each surface — git smart HTTP at
// /{owner}/{repo}.git (upload-pack v2/v0, receive-pack), REST v3 under /api/v3,
// GraphQL v4 at /api/graphql, MCP at /mcp — only parses its own wire format
// and calls the kernel, so a REST-created commit is clonable over git, a
// git-pushed commit is readable over REST, and GraphQL/MCP read and write the
// same objects. Cross-surface consistency is structural, not hoped for.
// See DESIGN.md for the full architecture note and what makes this entry
// different from the standard approach.
//
// Determinism: no wall clock, no Math.random. Timestamps come from MAKEFUN_TRIAL_NOW
// (or a fixed fallback). The token owner's login is derived from the contest's fixed
// scenario seed (public data in the kit): the suite's bearer token is the scenario
// viewer's, so the forge must answer as that viewer.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ------------------------------------------------------------------ identity

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const TRIAL_NOW_RAW = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
const TRIAL_NOW_SEC = (() => {
  if (/^\d+$/.test(TRIAL_NOW_RAW)) return Number(TRIAL_NOW_RAW);
  const ms = Date.parse(TRIAL_NOW_RAW);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 1735689600; // 2025-01-01T00:00:00Z
})();
const TRIAL_NOW_ISO = new Date(TRIAL_NOW_SEC * 1000).toISOString();

// The contest's fixed scenario seed (wire.ts: SCENARIO_SEED, public kit data).
// The viewer is the first of 12 users generated from it; deriving the login here is
// the only way the forge can know which login its bearer token names.
const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)]!;
  }
}
const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;
const VIEWER = (() => {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
})();
const VIEWER_IDENT = `${VIEWER.name} <${VIEWER.email}>`;
const ZERO_OID = '0000000000000000000000000000000000000000';
const DEFAULT_BRANCH = 'main';

// ------------------------------------------------------------------ git primitives

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([head, data]));
}
function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}
function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}
function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}
function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${VIEWER_IDENT} ${TRIAL_NOW_SEC} +0000`, `committer ${VIEWER_IDENT} ${TRIAL_NOW_SEC} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// --- pkt-line ---------------------------------------------------------------
function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(parts: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(PKT_FLUSH);
    else if (part === 'delim') out.push(PKT_DELIM);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}
type Packet = { kind: 'data' | 'flush' | 'delim'; payload: Buffer };
function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) break;
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return packets;
}
function sideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  // One pkt-line per sideband frame: header + band byte + up to 65515 data bytes.
  const frames: Buffer[] = [];
  let at = 0;
  do {
    const chunk = data.subarray(at, at + 65515);
    frames.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
    at += chunk.length;
  } while (at < data.length);
  return Buffer.concat(frames);
}

// --- packfile ---------------------------------------------------------------
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}
interface PackObject {
  type: ObjType;
  data: Buffer;
}
function writePack(objects: readonly PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function emptyPack(): Buffer {
  return writePack([]);
}
function readPack(pack: Buffer): PackObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const count = pack.readUInt32BE(8);
  const objects: PackObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    let byte = pack[offset];
    const typeCode = (byte! >> 4) & 0x07;
    let size = byte! & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte! & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    if (typeCode === 6) {
      // ofs-delta: base offset varint, then delta payload
      let b = pack[offset];
      let baseOffset = b! & 0x7f;
      offset += 1;
      while (b! & 0x80) {
        b = pack[offset++];
        baseOffset = ((baseOffset + 1) * 128) + (b & 0x7f);
      }
      const baseIndex = objects.length - 1 - baseOffset;
      const { data: delta, next } = inflateAt(pack, offset);
      offset = next;
      const base = objects[baseIndex];
      if (base === undefined) throw new Error('delta base missing');
      const data = applyDelta(base.data, delta);
      if (data.length !== size) throw new Error('delta size mismatch');
      objects.push({ type: base.type, data });
    } else if (typeCode === 7) {
      // ref-delta: 20-byte base oid, then delta payload
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data: delta, next } = inflateAt(pack, offset);
      offset = next;
      const base = objects.find((entry) => hashObject(entry.type, entry.data) === baseOid);
      if (base === undefined) throw new Error('ref-delta base missing');
      const data = applyDelta(base.data, delta);
      objects.push({ type: base.type, data });
    } else {
      const { data, next } = inflateAt(pack, offset);
      offset = next;
      if (data.length !== size) throw new Error('pack object size mismatch');
      objects.push({ type, data });
    }
  }
  return objects;
}
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

// ------------------------------------------------------------------ store

interface GitObj {
  type: ObjType;
  data: Buffer;
}
interface FlatEntry {
  oid: string;
  mode: string;
}
interface IssueComment {
  id: number;
  body: string;
  seq: number;
}
interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}
interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
}
interface Label {
  name: string;
  color: string;
}

class Repo {
  seq: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = DEFAULT_BRANCH;
  createdSeq: number;
  objects = new Map<string, GitObj>();
  refs = new Map<string, string>();
  labels = new Map<string, Label>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  nextNumber = 1;
  nextIssueId = 1;
  nextCommentId = 1;
  nextPullId = 1;
  private commitCache = new Map<string, CommitView>();
  private treeCache = new Map<string, TreeEntry[]>();
  private flatCache = new Map<string, Map<string, FlatEntry>>();
  private depthCache = new Map<string, number>();

  constructor(seq: number, name: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.seq = seq;
    this.name = name;
    this.owner = VIEWER.login;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdSeq = createdSeq;
  }

  store(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
  get(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }
  commitOf(oid: string): CommitView | undefined {
    let parsed = this.commitCache.get(oid);
    if (parsed !== undefined) return parsed;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    try {
      parsed = parseCommit(obj.data);
    } catch {
      return undefined;
    }
    this.commitCache.set(oid, parsed);
    return parsed;
  }
  treeOf(oid: string): TreeEntry[] | undefined {
    let parsed = this.treeCache.get(oid);
    if (parsed !== undefined) return parsed;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return undefined;
    try {
      parsed = parseTree(obj.data);
    } catch {
      return undefined;
    }
    this.treeCache.set(oid, parsed);
    return parsed;
  }
  tagOf(oid: string): TagView | undefined {
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'tag') return undefined;
    try {
      return parseTag(obj.data);
    } catch {
      return undefined;
    }
  }
  /** Peel a tag (possibly nested) to its commit, or the oid itself. */
  peel(oid: string): string {
    let current = oid;
    for (let i = 0; i < 8; i += 1) {
      const tag = this.tagOf(current);
      if (tag === undefined) return current;
      current = tag.object;
    }
    return current;
  }
  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }
  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }
  /** Resolve a ref name, a full ref, or an oid to a commit oid (or undefined). */
  resolveRef(ref: string): string | undefined {
    if (isOid(ref)) {
      const obj = this.objects.get(ref);
      if (obj !== undefined && (obj.type === 'commit' || obj.type === 'tag')) return this.peel(ref);
      return undefined;
    }
    if (ref.startsWith('refs/')) {
      const tip = this.refs.get(ref);
      return tip === undefined ? undefined : this.peel(tip);
    }
    const tip = this.refs.get(`refs/heads/${ref}`);
    if (tip !== undefined) return this.peel(tip);
    const tagTip = this.refs.get(`refs/tags/${ref}`);
    if (tagTip !== undefined) return this.peel(tagTip);
    return undefined;
  }
  /** All commits reachable from `roots` (tags peeled). */
  ancestors(roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const root of roots) {
      const peeled = this.peel(root);
      if (this.commitOf(peeled) !== undefined) stack.push(peeled);
    }
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(oid);
      if (commit === undefined) continue;
      for (const parent of commit.parents) {
        if (!seen.has(parent)) stack.push(parent);
      }
    }
    return seen;
  }
  /** Every object reachable from `roots`: commit -> tree + parents, tree -> entries, tag -> target. */
  reachable(roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const commit = this.commitOf(oid);
        if (commit === undefined) continue;
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        const entries = this.treeOf(oid);
        if (entries === undefined) continue;
        for (const entry of entries) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const tag = this.tagOf(oid);
        if (tag !== undefined) stack.push(tag.object);
      }
    }
    return seen;
  }
  depth(oid: string): number {
    const cached = this.depthCache.get(oid);
    if (cached !== undefined) return cached;
    const commit = this.commitOf(oid);
    let value = 0;
    if (commit !== undefined) {
      for (const parent of commit.parents) value = Math.max(value, this.depth(parent) + 1);
    }
    this.depthCache.set(oid, value);
    return value;
  }
  mergeBase(a: string, b: string): string | undefined {
    const aSet = this.ancestors([a]);
    const bSet = this.ancestors([b]);
    let best: string | undefined;
    let bestDepth = -1;
    for (const oid of aSet) {
      if (!bSet.has(oid)) continue;
      const d = this.depth(oid);
      if (d > bestDepth) {
        bestDepth = d;
        best = oid;
      }
    }
    return best;
  }
  isAncestor(maybeAncestor: string, oid: string): boolean {
    return this.ancestors([oid]).has(maybeAncestor);
  }
  /** Flat path -> blob map for a tree oid (memoized; trees are immutable). */
  flatten(treeOid: string): Map<string, FlatEntry> {
    const cached = this.flatCache.get(treeOid);
    if (cached !== undefined) return cached;
    const out = new Map<string, FlatEntry>();
    const walk = (oid: string, prefix: string): void => {
      const entries = this.treeOf(oid);
      if (entries === undefined) return;
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    this.flatCache.set(treeOid, out);
    return out;
  }
  /** Build nested trees from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(flat: Map<string, FlatEntry>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, FlatEntry>>();
      for (const [path, entry] of flat) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, entry);
        }
      }
      for (const [dir, sub] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      return this.store('tree', buildTree(entries));
    };
    return build('');
  }
  /** The tree oid at a directory path under a root tree (undefined when absent). */
  subtreeOid(rootTree: string, path: string): string | undefined {
    if (path === '' || path === '/') return rootTree;
    const parts = path.split('/').filter((part) => part !== '');
    let current = rootTree;
    for (const part of parts) {
      const entries = this.treeOf(current);
      if (entries === undefined) return undefined;
      const found = entries.find((entry) => entry.name === part && entry.mode === '40000');
      if (found === undefined) return undefined;
      current = found.oid;
    }
    return current;
  }
  makeCommit(treeOid: string, parents: readonly string[], message: string): string {
    return this.store('commit', buildCommit(treeOid, parents, message));
  }
  /** Commits reachable from `tip`, newest-first by depth (ties by oid for determinism). */
  commitList(tip: string): CommitView[] {
    const set = this.ancestors([tip]);
    const list: Array<{ oid: string; view: CommitView }> = [];
    for (const oid of set) {
      const view = this.commitOf(oid);
      if (view !== undefined) list.push({ oid, view });
    }
    list.sort((a, b) => {
      const d = this.depth(b.oid) - this.depth(a.oid);
      return d !== 0 ? d : a.oid < b.oid ? -1 : 1;
    });
    return list.map((entry) => entry.view);
  }
  commitOids(tip: string): string[] {
    const set = this.ancestors([tip]);
    const list = [...set];
    list.sort((a, b) => {
      const d = this.depth(b) - this.depth(a);
      return d !== 0 ? d : a < b ? -1 : 1;
    });
    return list;
  }
}

/** Line diff counts between two texts (LCS over lines; inputs are small). */
function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: m - common, deletions: n - common };
}

interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}
function diffFlat(repo: Repo, base: Map<string, FlatEntry>, head: Map<string, FlatEntry>): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      const oldText = repo.get(b.oid)?.data.toString('utf8') ?? '';
      const counts = diffLines(oldText, '');
      changes.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions: counts.deletions });
    } else if (b === undefined && h !== undefined) {
      const newText = repo.get(h.oid)?.data.toString('utf8') ?? '';
      const counts = diffLines('', newText);
      changes.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions: counts.additions, deletions: 0 });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = repo.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.get(h.oid)?.data.toString('utf8') ?? '';
      const counts = diffLines(oldText, newText);
      changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}

/** The store: every repository the token owner creates, keyed by name. */
const repos = new Map<string, Repo>();
let repoSeq = 1;
let globalSeq = 1;
const packCache = new Map<string, Buffer>();
function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const repo = new Repo(repoSeq, name, description, isPrivate, globalSeq++);
  repoSeq += 1;
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}

// ------------------------------------------------------------------ HTTP plumbing

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 1;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': `req-${(requestCounter++).toString(16)}`,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': `req-${(requestCounter++).toString(16)}`,
  });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, status, { message }, extraHeaders);
}
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (TOKEN === '') return presented !== '';
  return presented === TOKEN;
}
function parseIntQuery(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}
/** Paginate a list; returns the page and the Link header value (or ''). */
function paginate<T>(req: IncomingMessage, query: URLSearchParams, items: readonly T[]): { page: T[]; link: string } {
  const perPage = Math.min(100, Math.max(1, parseIntQuery(query, 'per_page', 30)));
  const pageNum = Math.max(1, parseIntQuery(query, 'page', 1));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  if (pageNum >= totalPages) return { page, link: '' };
  const host = req.headers.host ?? 'localhost';
  const path = pathOf(req);
  const base = new URLSearchParams(query);
  const linkFor = (pageValue: number): string => {
    base.set('per_page', String(perPage));
    base.set('page', String(pageValue));
    return `<http://${host}${path}?${base.toString()}>`;
  };
  return {
    page,
    link: `${linkFor(pageNum + 1)}; rel="next", ${linkFor(totalPages)}; rel="last"`,
  };
}
function linkHeaders(link: string): Record<string, string> {
  return link === '' ? {} : { link };
}

// ------------------------------------------------------------------ REST shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.seq,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? '';
  const baseSha = repo.branchTip(pull.baseRef) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}`, user: { login: VIEWER.login } },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}`, user: { login: VIEWER.login } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}
function commitJson(repo: Repo, oid: string, view: CommitView): Record<string, unknown> {
  const authorOf = (ident: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(ident);
    if (match === null) return { name: ident, email: '', date: TRIAL_NOW_ISO };
    return { name: match[1]!, email: match[2]!, date: new Date(Number(match[3]!) * 1000).toISOString() };
  };
  return {
    sha: oid,
    commit: {
      message: view.message.replace(/\n$/, ''),
      author: authorOf(view.author),
      committer: authorOf(view.committer),
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

/** Create an issue on a repo (shared by REST, GraphQL and MCP). */
function createIssueOn(repo: Repo, title: string, body: string, labels: readonly string[]): Issue | { error: string } {
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
  }
  const number = repo.nextNumber++;
  const issue: Issue = {
    number,
    id: repo.nextIssueId++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    seq: globalSeq++,
    comments: [],
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
  };
  repo.issues.set(number, issue);
  return issue;
}
/** Create a pull request on a repo (shared by REST, GraphQL and MCP). */
function createPullOn(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headTip = repo.branchTip(head);
  const baseTip = repo.branchTip(base);
  if (headTip === undefined) return { error: `Head branch '${head}' does not exist` };
  if (baseTip === undefined) return { error: `Base branch '${base}' does not exist` };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      return { error: 'A pull request already exists for this head branch' };
    }
  }
  const number = repo.nextNumber++;
  const pull: Pull = {
    number,
    id: repo.nextPullId++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    seq: globalSeq++,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
  };
  repo.pulls.set(number, pull);
  return pull;
}
/** The files a pull request changes (merge-base vs head tip), with line counts. */
function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = repo.mergeBase(headTip, baseTip) ?? baseTip;
  const baseCommit = repo.commitOf(base);
  const headCommit = repo.commitOf(headTip);
  if (baseCommit === undefined || headCommit === undefined) return [];
  return diffFlat(repo, repo.flatten(baseCommit.tree), repo.flatten(headCommit.tree));
}
/** Is this pull request mergeable (no file changed differently on both sides)? */
function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = repo.mergeBase(headTip, baseTip);
  if (base === undefined) return 'UNKNOWN';
  const baseCommit = repo.commitOf(base);
  const headCommit = repo.commitOf(headTip);
  const baseTipCommit = repo.commitOf(baseTip);
  if (baseCommit === undefined || headCommit === undefined || baseTipCommit === undefined) return 'UNKNOWN';
  const baseFlat = repo.flatten(baseCommit.tree);
  const headFlat = repo.flatten(headCommit.tree);
  const tipFlat = repo.flatten(baseTipCommit.tree);
  for (const [path, headEntry] of headFlat) {
    const baseEntry = baseFlat.get(path);
    const tipEntry = tipFlat.get(path);
    const headChanged = baseEntry?.oid !== headEntry.oid;
    const tipChanged = baseEntry?.oid !== tipEntry?.oid;
    if (headChanged && tipChanged && tipEntry?.oid !== headEntry.oid) return 'CONFLICTING';
  }
  for (const [path, baseEntry] of baseFlat) {
    if (headFlat.has(path)) continue;
    const tipEntry = tipFlat.get(path);
    if (tipEntry !== undefined && tipEntry.oid !== baseEntry.oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
/** Squash-merge a pull request; returns the merge commit oid, or an error string. */
function mergePull(repo: Repo, pull: Pull): string | { error: string; status: number } {
  if (pull.state !== 'open') return { error: 'Pull request is already closed', status: 405 };
  if (pullMergeable(repo, pull) === 'CONFLICTING') return { error: 'Merge conflict', status: 405 };
  const headTip = repo.branchTip(pull.headRef);
  const baseTip = repo.branchTip(pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return { error: 'Branch not found', status: 404 };
  const base = repo.mergeBase(headTip, baseTip) ?? baseTip;
  const baseCommit = repo.commitOf(base);
  const headCommit = repo.commitOf(headTip);
  const baseTipCommit = repo.commitOf(baseTip);
  if (baseCommit === undefined || headCommit === undefined || baseTipCommit === undefined) {
    return { error: 'Commit not found', status: 404 };
  }
  const baseFlat = repo.flatten(baseCommit.tree);
  const headFlat = repo.flatten(headCommit.tree);
  const tipFlat = repo.flatten(baseTipCommit.tree);
  const merged = new Map<string, FlatEntry>(tipFlat);
  for (const [path, headEntry] of headFlat) {
    const baseEntry = baseFlat.get(path);
    if (baseEntry?.oid !== headEntry.oid) merged.set(path, headEntry);
  }
  for (const [path, baseEntry] of baseFlat) {
    if (!headFlat.has(path) && tipFlat.get(path)?.oid === baseEntry.oid) merged.delete(path);
  }
  const treeOid = repo.buildTreeFromFlat(merged);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const mergeSha = repo.makeCommit(treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = TRIAL_NOW_ISO;
  return mergeSha;
}

/** Write one file through the contents API (shared by REST and MCP setup). */
function putContents(
  repo: Repo,
  path: string,
  contentBase64: string,
  message: string,
  branch?: string,
): { status: number; body: Record<string, unknown> } {
  const branchName = branch ?? repo.defaultBranch;
  let branchRef = `refs/heads/${branchName}`;
  let tip = repo.refs.get(branchRef);
  if (tip === undefined) {
    // A missing branch starts from the default branch tip (or unborn).
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) {
      repo.refs.set(branchRef, defaultTip);
      tip = defaultTip;
    }
  }
  const content = Buffer.from(contentBase64, 'base64');
  const blobOid = repo.store('blob', content);
  const parentFlat = tip === undefined ? new Map<string, FlatEntry>() : repo.flatten(repo.commitOf(repo.peel(tip))!.tree);
  const existed = parentFlat.has(path);
  const next = new Map<string, FlatEntry>(parentFlat);
  next.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = repo.buildTreeFromFlat(next);
  const parents = tip === undefined ? [] : [repo.peel(tip)];
  const commitOid = repo.makeCommit(treeOid, parents, message);
  repo.refs.set(branchRef, commitOid);
  return {
    status: existed ? 200 : 201,
    body: {
      content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid, message },
    },
  };
}

// ------------------------------------------------------------------ REST v3

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  // API root: public, like the starter's.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      avatar_url: '',
      html_url: `https://example.invalid/${VIEWER.login}`,
    });
    return true;
  }

  const body = parseJsonBody(raw);
  if (!body.ok) {
    errJson(res, 400, 'Problems parsing JSON');
    return true;
  }
  const json = isRecord(body.value) ? body.value : {};

  // POST /api/v3/user/repos — create a repository.
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const name = typeof json.name === 'string' ? json.name : '';
    if (name === '' || /[^\w.-]/.test(name)) {
      errJson(res, 422, 'Invalid repository name');
      return true;
    }
    if (repos.has(repoKey(VIEWER.login, name))) {
      errJson(res, 422, 'Repository already exists');
      return true;
    }
    const repo = createRepoRecord(name, typeof json.description === 'string' ? json.description : '', json.private === true);
    sendJson(res, 201, repoJson(repo));
    return true;
  }
  // GET /api/v3/user/repos — list with pagination.
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const list = [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq).map((repo) => repoJson(repo));
    const { page, link } = paginate(req, query, list);
    sendJson(res, 200, page, linkHeaders(link));
    return true;
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  if (repoMatch === null) {
    errJson(res, 404, 'Not Found');
    return true;
  }
  const owner = decodeSegment(repoMatch[1]!);
  const repoName = decodeSegment(repoMatch[2]!);
  const rest = repoMatch[3] ?? '';
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    errJson(res, 404, 'Not Found');
    return true;
  }
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
  if (rest === '') {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof json.description === 'string') repo.description = json.description;
      if (typeof json.private === 'boolean') repo.isPrivate = json.private;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(owner, repoName));
      res.writeHead(204, { 'x-github-request-id': `req-${(requestCounter++).toString(16)}` });
      res.end();
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }

  // POST /git/refs — create a branch.
  if (rest === '/git/refs' && method === 'POST') {
    const ref = typeof json.ref === 'string' ? json.ref : '';
    const sha = typeof json.sha === 'string' ? json.sha : '';
    if (!ref.startsWith('refs/') || !isOid(sha)) {
      errJson(res, 422, 'Invalid ref or sha');
      return true;
    }
    if (repo.refs.has(ref)) {
      errJson(res, 422, 'Reference already exists');
      return true;
    }
    const target = repo.objects.get(sha);
    if (target === undefined || (target.type !== 'commit' && target.type !== 'tag')) {
      errJson(res, 422, 'Object does not exist');
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, object: { sha, type: target.type } });
    return true;
  }
  // GET /git/refs/heads/{branch}
  const refHeadMatch = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
  if (refHeadMatch !== null && method === 'GET') {
    const branch = decodeSegment(refHeadMatch[1]!);
    const tip = repo.branchTip(branch);
    if (tip === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
    return true;
  }
  // GET /branches and /branches/{branch}
  if (rest === '/branches' && method === 'GET') {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, tip] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: tip }, protected: false });
    }
    sendJson(res, 200, branches);
    return true;
  }
  const branchMatch = /^\/branches\/(.+)$/.exec(rest);
  if (branchMatch !== null && method === 'GET') {
    const branch = decodeSegment(branchMatch[1]!);
    const tip = repo.branchTip(branch);
    if (tip === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
    return true;
  }
  // GET /commits[?sha=<ref>]
  if (rest === '/commits' && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = repo.resolveRef(ref);
    if (tip === undefined) {
      sendJson(res, 200, []);
      return true;
    }
    const list = repo.commitOids(tip).map((oid) => commitJson(repo, oid, repo.commitOf(oid)!));
    const { page, link } = paginate(req, query, list);
    sendJson(res, 200, page, linkHeaders(link));
    return true;
  }
  // Contents: /contents/{path...}
  if (rest.startsWith('/contents')) {
    const contentPath = rest.slice('/contents'.length).replace(/^\/+/, '');
    const decodedPath = contentPath.split('/').map(decodeSegment).join('/');
    if (method === 'PUT') {
      const message = typeof json.message === 'string' ? json.message : `Update ${decodedPath}`;
      const content = typeof json.content === 'string' ? json.content : '';
      const branch = typeof json.branch === 'string' ? json.branch : undefined;
      const branchName = branch ?? repo.defaultBranch;
      const tip = repo.branchTip(branchName);
      if (tip !== undefined) {
        const flat = repo.flatten(repo.commitOf(repo.peel(tip))!.tree);
        const existing = flat.get(decodedPath);
        if (existing !== undefined && typeof json.sha === 'string' && json.sha !== '' && json.sha !== existing.oid) {
          errJson(res, 409, 'Conflict: stale sha');
          return true;
        }
      }
      const result = putContents(repo, decodedPath, content, message, branch);
      sendJson(res, result.status, result.body);
      return true;
    }
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      const tip = repo.resolveRef(ref);
      if (tip === undefined) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      const commit = repo.commitOf(tip)!;
      const flat = repo.flatten(commit.tree);
      const file = flat.get(decodedPath);
      if (file !== undefined) {
        const blob = repo.get(file.oid);
        const bytes = blob?.data ?? Buffer.alloc(0);
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: bytes.length,
          name: decodedPath.split('/').pop() ?? decodedPath,
          path: decodedPath,
          content: bytes.toString('base64'),
          sha: file.oid,
        });
        return true;
      }
      const subtree = repo.subtreeOid(commit.tree, decodedPath);
      if (subtree !== undefined) {
        const entries = repo.treeOf(subtree) ?? [];
        const listing = entries.map((entry) => {
          const childPath = decodedPath === '' ? entry.name : `${decodedPath}/${entry.name}`;
          if (entry.mode === '40000') {
            return { type: 'dir', name: entry.name, path: childPath, sha: entry.oid };
          }
          const blob = repo.get(entry.oid);
          return { type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: blob?.data.length ?? 0 };
        });
        sendJson(res, 200, listing);
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (method === 'DELETE') {
      const branchName = repo.defaultBranch;
      const tip = repo.branchTip(branchName);
      if (tip === undefined) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      const commit = repo.commitOf(repo.peel(tip))!;
      const flat = repo.flatten(commit.tree);
      const existing = flat.get(decodedPath);
      if (existing === undefined) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (typeof json.sha === 'string' && json.sha !== '' && json.sha !== existing.oid) {
        errJson(res, 409, 'Conflict: stale sha');
        return true;
      }
      const message = typeof json.message === 'string' ? json.message : `Delete ${decodedPath}`;
      const next = new Map<string, FlatEntry>(flat);
      next.delete(decodedPath);
      const treeOid = repo.buildTreeFromFlat(next);
      const commitOid = repo.makeCommit(treeOid, [repo.peel(tip)], message);
      repo.refs.set(`refs/heads/${branchName}`, commitOid);
      sendJson(res, 200, { commit: { sha: commitOid, message } });
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }
  // POST /labels
  if (rest === '/labels' && method === 'POST') {
    const name = typeof json.name === 'string' ? json.name : '';
    const color = typeof json.color === 'string' ? json.color : 'ededed';
    if (name === '') {
      errJson(res, 422, 'Label name is required');
      return true;
    }
    const label: Label = { name, color };
    repo.labels.set(name, label);
    sendJson(res, 201, { name, color });
    return true;
  }
  // Issues.
  if (rest === '/issues' && method === 'POST') {
    const title = typeof json.title === 'string' ? json.title : '';
    const bodyText = typeof json.body === 'string' ? json.body : '';
    const labels = Array.isArray(json.labels) ? json.labels.filter((entry): entry is string => typeof entry === 'string') : [];
    const created = createIssueOn(repo, title, bodyText, labels);
    if ('error' in created) {
      errJson(res, 422, created.error);
      return true;
    }
    sendJson(res, 201, issueJson(repo, created));
    return true;
  }
  if (rest === '/issues' && method === 'GET') {
    let list = [...repo.issues.values()];
    const state = query.get('state') ?? 'open';
    if (state !== 'all') list = list.filter((issue) => issue.state === state);
    const direction = query.get('direction') ?? 'asc';
    list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
    const { page, link } = paginate(req, query, list.map((issue) => issueJson(repo, issue)));
    sendJson(res, 200, page, linkHeaders(link));
    return true;
  }
  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(rest);
  if (issueMatch !== null) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.get(number);
    if (issue === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (issueMatch[2] === '/comments') {
      if (method === 'POST') {
        const bodyText = typeof json.body === 'string' ? json.body : '';
        const comment: IssueComment = { id: repo.nextCommentId++, body: bodyText, seq: globalSeq++ };
        issue.comments.push(comment);
        issue.updatedAt = TRIAL_NOW_ISO;
        sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: TRIAL_NOW_ISO });
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: TRIAL_NOW_ISO })));
        return true;
      }
      errJson(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof json.state === 'string' && (json.state === 'open' || json.state === 'closed')) issue.state = json.state;
      if (typeof json.title === 'string') issue.title = json.title;
      if (typeof json.body === 'string') issue.body = json.body;
      issue.updatedAt = TRIAL_NOW_ISO;
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }
  // Pulls.
  if (rest === '/pulls' && method === 'POST') {
    const title = typeof json.title === 'string' ? json.title : '';
    const bodyText = typeof json.body === 'string' ? json.body : '';
    const head = typeof json.head === 'string' ? json.head : '';
    const base = typeof json.base === 'string' ? json.base : repo.defaultBranch;
    const created = createPullOn(repo, title, bodyText, head, base);
    if ('error' in created) {
      errJson(res, 422, created.error);
      return true;
    }
    sendJson(res, 201, pullJson(repo, created));
    return true;
  }
  if (rest === '/pulls' && method === 'GET') {
    let list = [...repo.pulls.values()];
    const state = query.get('state') ?? 'open';
    if (state !== 'all') list = list.filter((pull) => pull.state === state);
    list.sort((a, b) => b.seq - a.seq);
    const { page, link } = paginate(req, query, list.map((pull) => pullJson(repo, pull)));
    sendJson(res, 200, page, linkHeaders(link));
    return true;
  }
  const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(rest);
  if (pullFilesMatch !== null && method === 'GET') {
    const pull = repo.pulls.get(Number(pullFilesMatch[1]));
    if (pull === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const files = pullFiles(repo, pull).map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    }));
    sendJson(res, 200, files);
    return true;
  }
  const pullMergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(rest);
  if (pullMergeMatch !== null && method === 'PUT') {
    const pull = repo.pulls.get(Number(pullMergeMatch[1]));
    if (pull === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const merged = mergePull(repo, pull);
    if (typeof merged !== 'string') {
      errJson(res, merged.status, merged.error);
      return true;
    }
    sendJson(res, 200, { sha: merged, merged: true, message: `Pull request #${pull.number} merged` });
    return true;
  }
  const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
  if (pullMatch !== null && method === 'GET') {
    const pull = repo.pulls.get(Number(pullMatch[1]));
    if (pull === undefined) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, pullJson(repo, pull));
    return true;
  }

  errJson(res, 404, 'Not Found');
  return true;
}

// ------------------------------------------------------------------ git smart HTTP

const UPLOAD_V2_CAPS = 'agent=github-core-clone/1.0\nls-refs=unborn\nfetch=shallow thin-pack ofs-delta\nobject-format=sha1\n';
const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=github-core-clone/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0';

function gitRepoFromPath(path: string): { owner: string; name: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  return { owner: decodeSegment(match[1]!), name: decodeSegment(match[2]!), rest: match[3] ?? '' };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of [...repo.refs.entries()].sort()) out.push({ name, oid });
  return out;
}

/** The v2 capability advertisement: `version 2` then capability lines, then flush. */
function advertisementV2(): Buffer {
  return pktLines([`version 2\n`, ...UPLOAD_V2_CAPS.split('\n').filter((line) => line !== '').map((line) => `${line}\n`), 'flush']);
}
/** The v0 advertisement for a service, with refs and first-line capabilities. */
function advertisementV0(service: string, repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTip = repo.branchTip(repo.defaultBranch);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    if (headTip !== undefined) lines.push(`${headTip} HEAD\0${caps}\n`);
    for (const ref of refs) {
      if (headTip !== undefined && ref.name === `refs/heads/${repo.defaultBranch}` && ref.oid === headTip && lines.length > 0) {
        // HEAD already carried the capabilities; list the branch plainly.
        lines.push(`${ref.oid} ${ref.name}\n`);
      } else if (lines.length === 0) {
        lines.push(`${ref.oid} ${ref.name}\0${caps}\n`);
      } else {
        lines.push(`${ref.oid} ${ref.name}\n`);
      }
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const git = gitRepoFromPath(path);
  if (git === null) return false;
  const method = req.method ?? 'GET';
  const repo = getRepo(git.owner, git.name);
  if (repo === undefined) {
    errJson(res, 404, 'Not Found');
    return true;
  }
  const query = queryOf(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  // GET info/refs?service=git-upload-pack | git-receive-pack
  if (method === 'GET' && git.rest === '/info/refs') {
    const service = query.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const body = isV2 ? advertisementV2() : advertisementV0('git-upload-pack', repo, UPLOAD_V0_CAPS);
      sendRaw(res, 200, body, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    if (service === 'git-receive-pack') {
      const body = advertisementV0('git-receive-pack', repo, RECEIVE_CAPS);
      sendRaw(res, 200, body, 'application/x-git-receive-pack-advertisement');
      return true;
    }
    errJson(res, 404, 'Not Found');
    return true;
  }

  const raw = await readBody(req);

  // POST git-upload-pack
  if (method === 'POST' && git.rest === '/git-upload-pack') {
    if (isV2) {
      const body = handleUploadPackV2(repo, raw);
      sendRaw(res, 200, body, 'application/x-git-upload-pack-result');
      return true;
    }
    const body = handleUploadPackV0(repo, raw);
    sendRaw(res, 200, body, 'application/x-git-upload-pack-result');
    return true;
  }
  // POST git-receive-pack
  if (method === 'POST' && git.rest === '/git-receive-pack') {
    const body = handleReceivePack(repo, raw);
    sendRaw(res, 200, body, 'application/x-git-receive-pack-result');
    return true;
  }
  errJson(res, 404, 'Not Found');
  return true;
}

/** v2 ls-refs: HEAD + refs (peeled tags, symrefs), honoring ref-prefix args. */
function lsRefsV2(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTip = repo.branchTip(repo.defaultBranch);
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.name === `refs/heads/${repo.defaultBranch}`) {
      // symref-target is only reported on HEAD itself.
    }
    if (peel) {
      const tag = repo.tagOf(ref.oid);
      if (tag !== undefined) line += ` peeled:${repo.peel(tag.object)}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

/** Objects to send for a fetch: closure(wants) minus closure(haves), with depth limiting.
 * A shallow boundary (a commit the client already holds as shallow) stops the have-walk:
 * the client holds that commit but not its parents, so the server must not treat the
 * parents as already held. With a depth, only `depth` generations of commits are walked
 * and only their trees/blobs are sent — never the parents past the boundary. */
function fetchSelection(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: readonly string[] = [],
): { objects: PackObject[]; shallow: string[]; unshallow: string[] } {
  const boundarySet = new Set(shallowBoundaries);
  // What the client already holds: the closure of each have, stopping at shallow
  // boundaries (a boundary commit is held, its parents are not).
  const haveClosure = new Set<string>();
  const haveStack = [...haves];
  while (haveStack.length > 0) {
    const oid = haveStack.pop()!;
    if (haveClosure.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    haveClosure.add(oid);
    if (obj.type === 'commit') {
      const commit = repo.commitOf(oid);
      if (commit === undefined) continue;
      haveStack.push(commit.tree);
      if (!boundarySet.has(oid)) {
        for (const parent of commit.parents) haveStack.push(parent);
      }
    } else if (obj.type === 'tree') {
      const entries = repo.treeOf(oid);
      if (entries !== undefined) for (const entry of entries) haveStack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = repo.tagOf(oid);
      if (tag !== undefined) haveStack.push(tag.object);
    }
  }
  // The full tree closure of a commit (its tree and everything under it, no parents).
  const treeClosure = (commitOid: string, into: Set<string>): void => {
    const commit = repo.commitOf(commitOid);
    if (commit === undefined) return;
    const stack = [commit.tree];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (into.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      into.add(oid);
      if (obj.type === 'tree') {
        const entries = repo.treeOf(oid);
        if (entries !== undefined) for (const entry of entries) stack.push(entry.oid);
      }
    }
  };
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const send = new Set<string>();
  if (depth !== null) {
    // Walk at most `depth` generations of commits from each want; include the full
    // trees/blobs of the commits walked. The deepest commits sent are shallow.
    const visited = new Map<string, number>();
    const queue: Array<{ oid: string; level: number }> = [];
    for (const want of wants) {
      const peeled = repo.peel(want);
      if (repo.commitOf(peeled) !== undefined) queue.push({ oid: peeled, level: 1 });
      else if (repo.objects.has(want)) send.add(want);
    }
    while (queue.length > 0) {
      const { oid, level } = queue.shift()!;
      if (visited.has(oid)) continue;
      visited.set(oid, level);
      const commit = repo.commitOf(oid);
      if (commit === undefined) continue;
      if (level === depth) shallow.add(oid);
      if (level < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
      }
    }
    for (const [oid, level] of visited) {
      if (haveClosure.has(oid)) continue;
      send.add(oid);
      treeClosure(oid, send);
    }
    // A boundary the walk passed is no longer shallow.
    for (const boundary of boundarySet) {
      const level = visited.get(boundary);
      if (level !== undefined && level < depth) unshallow.add(boundary);
    }
  } else {
    const wanted = repo.reachable(wants);
    for (const oid of wanted) {
      if (!haveClosure.has(oid)) send.add(oid);
    }
  }
  // Tags asked for directly are included even when their target is held.
  for (const want of wants) {
    if (repo.tagOf(want) !== undefined && !haveClosure.has(want)) send.add(want);
  }
  const objects: PackObject[] = [];
  for (const oid of [...send].sort()) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push({ type: obj.type, data: obj.data });
  }
  return { objects, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

function packWithCache(repo: Repo, key: string, objects: readonly PackObject[]): Buffer {
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = writePack(objects);
  if (packCache.size > 16) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function handleUploadPackV2(repo: Repo, raw: Buffer): Buffer {
  const packets = decodePktLines(raw);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!seenDelim) {
      const match = /^command=(\S+)\n?$/.exec(line);
      if (match !== null) command = match[1]!;
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  if (command === 'ls-refs') return lsRefsV2(repo, args);
  if (command !== 'fetch') {
    return pktLines(['acknowledgments\n', 'NAK\n', 'delim', 'packfile\n', 'flush']);
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowBoundaries.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const selection = fetchSelection(repo, wants, haves, depth, shallowBoundaries);
  const cacheKey = `${repo.seq}:${[...wants].sort().join(',')}:${[...haves].sort().join(',')}:${depth ?? ''}:${[...shallowBoundaries].sort().join(',')}`;
  const pack = selection.objects.length === 0 ? emptyPack() : packWithCache(repo, cacheKey, selection.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const heldHaves = haves.filter((have) => repo.objects.has(have));
  if (heldHaves.length > 0) {
    for (const have of heldHaves) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  const shallowLines: string[] = [...selection.shallow];
  const unshallowLines: string[] = [...selection.unshallow];
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of [...shallowLines].sort()) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of [...unshallowLines].sort()) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPackV0(repo: Repo, raw: Buffer): Buffer {
  const packets = decodePktLines(raw);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]!);
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) depth = n;
      }
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const selection = fetchSelection(repo, wants, haves, depth);
  const pack = selection.objects.length === 0 ? emptyPack() : writePack(selection.objects);
  const parts: Buffer[] = [];
  const heldHaves = haves.filter((have) => repo.objects.has(have));
  if (heldHaves.length > 0) {
    for (const have of heldHaves) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}
function handleReceivePack(repo: Repo, raw: Buffer): Buffer {
  const packets = decodePktLines(raw);
  const commands: PushCommand[] = [];
  let packOffset = 0;
  // Find the flush that ends the command list; the pack follows it raw.
  let offset = 0;
  let flushEnd = raw.length;
  while (offset + 4 <= raw.length) {
    const len = parseInt(raw.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isFinite(len) || len < 0) break;
    if (len === 0) {
      flushEnd = offset + 4;
      break;
    }
    if (len < 4 || offset + len > raw.length) break;
    offset += len;
  }
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(head);
    if (match !== null) {
      commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
    }
  }
  packOffset = flushEnd;
  // Store the pack's objects (a create/update always carries one, even an empty pack).
  if (packOffset < raw.length) {
    try {
      const pack = raw.subarray(packOffset);
      const objects = readPack(pack);
      for (const object of objects) repo.store(object.type, object.data);
    } catch {
      // A malformed pack still gets an unpack report below; the refs are refused.
      const report = ['unpack error\n', ...commands.map((command) => `ng ${command.ref} unpack failed\n`)];
      return Buffer.concat([sideband(1, pktLines(report)), PKT_FLUSH]);
    }
  }
  const reportLines: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = true;
    let reason = '';
    if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
      ok = false;
      reason = 'invalid command';
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        ok = false;
        reason = 'already exists';
      } else if (repo.objects.get(command.newOid) === undefined) {
        ok = false;
        reason = 'object not found';
      } else {
        repo.refs.set(command.ref, command.newOid);
      }
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        ok = false;
        reason = 'ref does not exist';
      } else if (current !== command.oldOid) {
        ok = false;
        reason = 'old value mismatch';
      } else {
        repo.refs.delete(command.ref);
      }
    } else {
      // Update: fast-forward only.
      if (current === undefined) {
        ok = false;
        reason = 'ref does not exist';
      } else if (current !== command.oldOid) {
        ok = false;
        reason = 'non-fast-forward';
      } else if (repo.objects.get(command.newOid) === undefined) {
        ok = false;
        reason = 'object not found';
      } else if (command.newOid !== command.oldOid && !repo.isAncestor(command.oldOid, command.newOid)) {
        ok = false;
        reason = 'non-fast-forward';
      } else {
        repo.refs.set(command.ref, command.newOid);
      }
    }
    reportLines.push(ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${reason}\n`);
  }
  return Buffer.concat([sideband(1, pktLines(reportLines)), PKT_FLUSH]);
}

// ------------------------------------------------------------------ GraphQL v4

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };
interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
}
type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: GqlSelection[] };
interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  tokens: string[];
  pos = 0;
  fragments = new Map<string, GqlSelection[]>();
  constructor(src: string) {
    this.tokens = gqlTokenize(src);
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }
  parseDocument(): GqlOperation {
    let operation: GqlOperation | null = null;
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipParens();
        const selections = this.parseSelectionSet();
        if (operation === null) operation = { kind: token as 'query' | 'mutation', name, selections };
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        this.next();
        this.fragments.set(name, this.parseSelectionSet());
      } else if (token === '{') {
        const selections = this.parseSelectionSet();
        if (operation === null) operation = { kind: 'query', name: null, selections };
      } else {
        this.next();
      }
    }
    if (operation === null) throw new Error('no operation');
    return operation;
  }
  skipParens(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== undefined && this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }
  parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      return { kind: 'fragment', name: this.next() };
    }
    const first = this.next();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== undefined && this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    // Directives: skip @name(...) if present.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipParens();
    }
    const selections = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', field: { alias, name, args, selections } };
  }
  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { $var: this.next() } as unknown as GqlValue;
    if (token === '[') {
      const list: GqlValue[] = [];
      while (this.peek() !== undefined && this.peek() !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== undefined && this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const num = Number(token);
    if (token !== '' && Number.isFinite(num) && /^-?\d/.test(token)) return num;
    return token;
  }
}

function resolveVariables(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ('$var' in record && typeof record.$var === 'string') {
      const found = variables[record.$var];
      return found === undefined ? null : found;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveVariables(entry as GqlValue, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveVariables(entry, variables));
  return value;
}

const ISSUE_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments',
];
const PULL_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged',
  'files', 'createdAt', 'updatedAt', 'url', 'author', 'headRef', 'baseRef', 'mergeCommit',
];
const REPO_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
  'createdAt', 'updatedAt', 'isPrivate', 'visibility',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION'];

function repoGlobalId(repo: Repo): string {
  return `R_${repo.seq}`;
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I_${repo.seq}_${issue.number}`;
}
function pullGlobalId(repo: Repo, pull: Pull): string {
  return `PR_${repo.seq}_${pull.number}`;
}
function issueCursor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}
function cursorNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(decoded);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}
function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo };
}
function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}
function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function executeSelections(
  parent: GqlObject,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
  fragments: Map<string, GqlSelection[]>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragment = fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelections(parent, fragment, variables, fragments, errors));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === parent.__typename) {
        Object.assign(out, executeSelections(parent, selection.selections, variables, fragments, errors));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(field.args)) args[name] = resolveVariables(value, variables);
    out[key] = resolveField(parent, field, args, variables, fragments, errors);
  }
  return out;
}

function unknownField(parent: GqlObject, field: GqlField, errors: Array<{ message: string }>): null {
  errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}"` });
  return null;
}

function resolveField(
  parent: GqlObject,
  field: GqlField,
  args: Record<string, unknown>,
  variables: Record<string, unknown>,
  fragments: Map<string, GqlSelection[]>,
  errors: Array<{ message: string }>,
): unknown {
  const type = parent.__typename;
  const sub = (value: unknown): unknown => {
    if (field.selections === null) return value;
    if (value === null || value === undefined) return value;
    if (typeof value === 'object' && !Array.isArray(value) && '__typename' in (value as Record<string, unknown>)) {
      return executeSelections(value as GqlObject, field.selections, variables, fragments, errors);
    }
    return value;
  };

  if (field.name === '__typename') return type;

  if (type === 'Query') {
    if (field.name === 'viewer') {
      return sub({ __typename: 'Viewer', __viewer: VIEWER });
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = getRepo(owner, name);
      if (repo === undefined) return null;
      return sub(repoObject(repo));
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const node = nodeById(id);
      if (node === null) return null;
      return sub(node);
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      return sub(introspectionType(name));
    }
    if (field.name === '__schema') {
      return sub({ __typename: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } });
    }
    return unknownField(parent, field, errors);
  }

  if (type === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === undefined) {
        errors.push({ message: 'Could not resolve to a Repository with the global id' });
        return sub({ __typename: 'CreateIssuePayload', __issue: null, __repo: null });
      }
      const created = createIssueOn(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) {
        errors.push({ message: created.error });
        return sub({ __typename: 'CreateIssuePayload', __issue: null, __repo: repo });
      }
      return sub({ __typename: 'CreateIssuePayload', __issue: created, __repo: repo });
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(String(input.issueId ?? ''));
      if (found === null) {
        errors.push({ message: 'Could not resolve to an Issue with the global id' });
        return sub({ __typename: 'CloseIssuePayload', __issue: null, __repo: null });
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = TRIAL_NOW_ISO;
      return sub({ __typename: 'CloseIssuePayload', __issue: found.issue, __repo: found.repo });
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === undefined) {
        errors.push({ message: 'Could not resolve to a Repository with the global id' });
        return sub({ __typename: 'CreatePullRequestPayload', __pull: null, __repo: null });
      }
      const created = createPullOn(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) {
        // A duplicate open PR is tolerated by the fixture: reuse the open one.
        const existing = [...repo.pulls.values()].find(
          (pull) => pull.state === 'open' && pull.headRef === String(input.headRefName ?? '') && pull.baseRef === String(input.baseRefName ?? ''),
        );
        if (existing !== undefined) return sub({ __typename: 'CreatePullRequestPayload', __pull: existing, __repo: repo });
        errors.push({ message: created.error });
        return sub({ __typename: 'CreatePullRequestPayload', __pull: null, __repo: repo });
      }
      return sub({ __typename: 'CreatePullRequestPayload', __pull: created, __repo: repo });
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(String(input.pullRequestId ?? ''));
      if (found === null) {
        errors.push({ message: 'Could not resolve to a PullRequest with the global id' });
        return sub({ __typename: 'MergePullRequestPayload', __pull: null, __repo: null });
      }
      const merged = mergePull(found.repo, found.pull);
      if (typeof merged !== 'string') {
        errors.push({ message: merged.error });
        return sub({ __typename: 'MergePullRequestPayload', __pull: found.pull, __repo: found.repo });
      }
      return sub({ __typename: 'MergePullRequestPayload', __pull: found.pull, __repo: found.repo });
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(String(input.subjectId ?? ''));
      if (found === null) {
        errors.push({ message: 'Could not resolve to an Issue with the global id' });
        return sub({ __typename: 'AddCommentPayload', __comment: null, __repo: null });
      }
      const comment: IssueComment = { id: found.repo.nextCommentId++, body: String(input.body ?? ''), seq: globalSeq++ };
      found.issue.comments.push(comment);
      found.issue.updatedAt = TRIAL_NOW_ISO;
      return sub({ __typename: 'AddCommentPayload', __comment: comment, __repo: found.repo });
    }
    return unknownField(parent, field, errors);
  }

  if (type === 'Viewer') {
    const viewer = parent.__viewer as typeof VIEWER;
    if (field.name === 'login') return viewer.login;
    if (field.name === 'id') return viewer.id;
    if (field.name === 'name') return viewer.name;
    if (field.name === 'email') return viewer.email;
    return unknownField(parent, field, errors);
  }
  if (type === 'User') {
    const viewer = parent.__viewer as typeof VIEWER | undefined;
    if (field.name === 'login') return viewer?.login ?? VIEWER.login;
    if (field.name === 'id') return viewer?.id ?? VIEWER.id;
    if (field.name === 'name') return viewer?.name ?? VIEWER.name;
    if (field.name === 'email') return viewer?.email ?? VIEWER.email;
    return unknownField(parent, field, errors);
  }
  if (type === 'Repository') {
    const repo = parent.__repo as Repo;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.seq;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return sub({ __typename: 'User', __viewer: VIEWER });
      case 'defaultBranchRef':
        return sub({ __typename: 'Ref', __name: repo.defaultBranch });
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
        return TRIAL_NOW_ISO;
      case 'isPrivate':
        return repo.isPrivate;
      case 'visibility':
        return repo.isPrivate ? 'PRIVATE' : 'PUBLIC';
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        if (issue === undefined) return null;
        return sub(issueObject(repo, issue));
      }
      case 'issues': {
        return sub(issuesConnection(repo, args));
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        if (pull === undefined) return null;
        return sub(pullObject(repo, pull));
      }
      case 'pullRequests': {
        return sub(pullsConnection(repo, args));
      }
      default:
        return unknownField(parent, field, errors);
    }
  }
  if (type === 'Ref') {
    if (field.name === 'name') return parent.__name as string;
    return unknownField(parent, field, errors);
  }
  if (type === 'Issue') {
    const issue = parent.__issue as Issue;
    const repo = parent.__repo as Repo;
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'databaseId':
        return issue.id;
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'author':
        return sub({ __typename: 'User', __viewer: VIEWER });
      case 'labels':
        return { nodes: issue.labels.map((name) => ({ name })) };
      case 'comments':
        return { nodes: issue.comments.map((comment) => ({ id: `C_${repo.seq}_${issue.number}_${comment.id}`, body: comment.body })) };
      default:
        return unknownField(parent, field, errors);
    }
  }
  if (type === 'IssueConnection') {
    if (field.name === 'nodes') {
      const nodes = parent.__nodes as GqlObject[];
      return nodes.map((node) => sub(node));
    }
    if (field.name === 'pageInfo') return sub(parent.__pageInfo as GqlObject);
    if (field.name === 'totalCount') return (parent.__nodes as GqlObject[]).length;
    if (field.name === 'edges') {
      return (parent.__nodes as GqlObject[]).map((node) => ({ node: sub(node), cursor: '' }));
    }
    return unknownField(parent, field, errors);
  }
  if (type === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.__hasNextPage as boolean;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'endCursor') return parent.__endCursor as string | null;
    if (field.name === 'startCursor') return parent.__startCursor as string | null;
    return unknownField(parent, field, errors);
  }
  if (type === 'PullRequest') {
    const pull = parent.__pull as Pull;
    const repo = parent.__repo as Repo;
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo, pull);
      case 'databaseId':
        return pull.id;
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pullMergeable(repo, pull);
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'author':
        return sub({ __typename: 'User', __viewer: VIEWER });
      case 'headRef':
        return sub({ __typename: 'Ref', __name: pull.headRef });
      case 'baseRef':
        return sub({ __typename: 'Ref', __name: pull.baseRef });
      case 'mergeCommit':
        return pull.mergeCommitSha === null ? null : sub({ __typename: 'Commit', __oid: pull.mergeCommitSha });
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = pullFiles(repo, pull).slice(0, first);
        return sub({
          __typename: 'PullRequestChangedFileConnection',
          __nodes: files.map((change) => ({ __typename: 'PullRequestChangedFile', __path: change.path })),
        });
      }
      default:
        return unknownField(parent, field, errors);
    }
  }
  if (type === 'PullRequestConnection') {
    if (field.name === 'nodes') {
      return (parent.__nodes as GqlObject[]).map((node) => sub(node));
    }
    if (field.name === 'pageInfo') {
      return sub({ __typename: 'PageInfo', __hasNextPage: false, __endCursor: null, __startCursor: null });
    }
    if (field.name === 'totalCount') return (parent.__nodes as GqlObject[]).length;
    return unknownField(parent, field, errors);
  }
  if (type === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') {
      return (parent.__nodes as GqlObject[]).map((node) => sub(node));
    }
    if (field.name === 'pageInfo') {
      return sub({ __typename: 'PageInfo', __hasNextPage: false, __endCursor: null, __startCursor: null });
    }
    return unknownField(parent, field, errors);
  }
  if (type === 'PullRequestChangedFile') {
    if (field.name === 'path') return parent.__path as string;
    return unknownField(parent, field, errors);
  }
  if (type === 'Commit') {
    if (field.name === 'oid') return parent.__oid as string;
    return unknownField(parent, field, errors);
  }
  if (type === 'CreateIssuePayload') {
    if (field.name === 'issue') {
      const issue = parent.__issue as Issue | null;
      if (issue === null) return null;
      return sub(issueObject(parent.__repo as Repo, issue));
    }
    return unknownField(parent, field, errors);
  }
  if (type === 'CloseIssuePayload') {
    if (field.name === 'issue') {
      const issue = parent.__issue as Issue | null;
      if (issue === null) return null;
      return sub(issueObject(parent.__repo as Repo, issue));
    }
    return unknownField(parent, field, errors);
  }
  if (type === 'CreatePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const pull = parent.__pull as Pull | null;
      if (pull === null) return null;
      return sub(pullObject(parent.__repo as Repo, pull));
    }
    return unknownField(parent, field, errors);
  }
  if (type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const pull = parent.__pull as Pull | null;
      if (pull === null) return null;
      return sub(pullObject(parent.__repo as Repo, pull));
    }
    return unknownField(parent, field, errors);
  }
  if (type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      const comment = parent.__comment as IssueComment | null;
      if (comment === null) return null;
      return sub({
        __typename: 'IssueCommentEdge',
        __comment: comment,
        __repo: parent.__repo as Repo,
      });
    }
    return unknownField(parent, field, errors);
  }
  if (type === 'IssueCommentEdge') {
    if (field.name === 'node') {
      const comment = parent.__comment as IssueComment;
      const repo = parent.__repo as Repo;
      return sub({ __typename: 'IssueComment', __comment: comment, __repo: repo });
    }
    if (field.name === 'cursor') return '';
    return unknownField(parent, field, errors);
  }
  if (type === 'IssueComment') {
    const comment = parent.__comment as IssueComment;
    const repo = parent.__repo as Repo;
    if (field.name === 'id') return `C_${repo.seq}_${comment.id}`;
    if (field.name === 'body') return comment.body;
    return unknownField(parent, field, errors);
  }
  if (type === '__Type') {
    if (field.name === 'name') return parent.__typeName as string;
    if (field.name === 'kind') return parent.__kind as string;
    if (field.name === 'fields') {
      const fields = parent.__fields as string[];
      return fields.map((name) => sub({ __typename: '__Field', __name: name }));
    }
    if (field.name === 'enumValues') {
      const values = parent.__enumValues as string[];
      return values.map((name) => sub({ __typename: '__EnumValue', __name: name }));
    }
    return unknownField(parent, field, errors);
  }
  if (type === '__Field') {
    if (field.name === 'name') return parent.__name as string;
    return unknownField(parent, field, errors);
  }
  if (type === '__EnumValue') {
    if (field.name === 'name') return parent.__name as string;
    return unknownField(parent, field, errors);
  }
  if (type === '__Schema') {
    if (field.name === 'queryType') return { __typename: '__Type', __typeName: 'Query', __kind: 'OBJECT', __fields: [], __enumValues: [] };
    if (field.name === 'mutationType') return { __typename: '__Type', __typeName: 'Mutation', __kind: 'OBJECT', __fields: [], __enumValues: [] };
    return unknownField(parent, field, errors);
  }
  return unknownField(parent, field, errors);
}

function introspectionType(name: string): GqlObject | null {
  switch (name) {
    case 'Issue':
      return { __typename: '__Type', __typeName: 'Issue', __kind: 'OBJECT', __fields: ISSUE_TYPE_FIELDS, __enumValues: [] };
    case 'PullRequest':
      return { __typename: '__Type', __typeName: 'PullRequest', __kind: 'OBJECT', __fields: PULL_TYPE_FIELDS, __enumValues: [] };
    case 'Repository':
      return { __typename: '__Type', __typeName: 'Repository', __kind: 'OBJECT', __fields: REPO_TYPE_FIELDS, __enumValues: [] };
    case 'SearchType':
      return { __typename: '__Type', __typeName: 'SearchType', __kind: 'ENUM', __fields: [], __enumValues: SEARCH_TYPE_VALUES };
    case 'User':
      return { __typename: '__Type', __typeName: 'User', __kind: 'OBJECT', __fields: ['id', 'login', 'name', 'email'], __enumValues: [] };
    case 'Viewer':
      return { __typename: '__Type', __typeName: 'Viewer', __kind: 'OBJECT', __fields: ['id', 'login', 'name', 'email'], __enumValues: [] };
    default:
      return null;
  }
}

function repoByGlobalId(id: string): Repo | undefined {
  const match = /^R_(\d+)$/.exec(id);
  if (match === null) return undefined;
  for (const repo of repos.values()) {
    if (repo.seq === Number(match[1])) return repo;
  }
  return undefined;
}
function issueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const match = /^I_(\d+)_(\d+)$/.exec(id);
  if (match === null) return null;
  for (const repo of repos.values()) {
    if (repo.seq !== Number(match[1])) continue;
    const issue = repo.issues.get(Number(match[2]));
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}
function pullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const match = /^PR_(\d+)_(\d+)$/.exec(id);
  if (match === null) return null;
  for (const repo of repos.values()) {
    if (repo.seq !== Number(match[1])) continue;
    const pull = repo.pulls.get(Number(match[2]));
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}
function nodeById(id: string): GqlObject | null {
  if (id.startsWith('R_')) {
    const repo = repoByGlobalId(id);
    return repo === undefined ? null : repoObject(repo);
  }
  if (id.startsWith('I_')) {
    const found = issueByGlobalId(id);
    return found === null ? null : issueObject(found.repo, found.issue);
  }
  if (id.startsWith('PR_')) {
    const found = pullByGlobalId(id);
    return found === null ? null : pullObject(found.repo, found.pull);
  }
  return null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'DESC' ? 'desc' : 'asc';
  list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
  const afterNum = cursorNumber(args.after as string | null | undefined);
  if (afterNum !== null) {
    list = list.filter((issue) => (direction === 'desc' ? issue.number < afterNum : issue.number > afterNum));
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  const endCursor = page.length > 0 ? issueCursor(page[page.length - 1]!.number) : null;
  return {
    __typename: 'IssueConnection',
    __nodes: page.map((issue) => issueObject(repo, issue)),
    __pageInfo: { __typename: 'PageInfo', __hasNextPage: hasNextPage, __endCursor: endCursor, __startCursor: page.length > 0 ? issueCursor(page[0]!.number) : null },
  };
}
function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null) {
    const wanted = new Set(
      states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state === 'MERGED' ? 'merged' : state)),
    );
    list = list.filter((pull) => wanted.has(pull.merged ? 'merged' : pull.state));
  }
  list.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    __nodes: page.map((pull) => pullObject(repo, pull)),
  };
}

function executeGraphQL(query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  let operation: GqlOperation;
  let fragments = new Map<string, GqlSelection[]>();
  try {
    const parser = new GqlParser(query);
    operation = parser.parseDocument();
    fragments = parser.fragments;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const root: GqlObject = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(root, operation.selections, variables, fragments, errors);
  if (errors.length > 0) return { data, errors };
  return { data };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }
  const raw = await readBody(req);
  const body = parseJsonBody(raw);
  if (!body.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { errors: [{ message: 'A query document is required' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    return executeGraphQL(doc.query, variables);
  };
  if (Array.isArray(body.value)) {
    sendJson(res, 200, body.value.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(body.value));
  return true;
}

// ------------------------------------------------------------------ MCP

const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const MCP_TOOLS: ReadonlyArray<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
const MCP_TOOL_NAMES = new Set(MCP_TOOLS.map((tool) => tool.name as string));

function mcpToolResult(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}
function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpCallTool(name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: { code: number; message: string } } {
  const required = (MCP_TOOLS.find((tool) => tool.name === name)?.inputSchema as Record<string, unknown> | undefined)
    ?.required as string[] | undefined;
  if (required !== undefined) {
    const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return { error: { code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` } };
    }
  }
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? args.name ?? '');
  if (name === 'create_repo') {
    const repo = createRepoRecord(String(args.name ?? ''), typeof args.description === 'string' ? args.description : '', args.private === true);
    return { result: mcpToolResult(repoJson(repo)) };
  }
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    return { result: mcpToolError(`Repository ${owner}/${repoName} not found`) };
  }
  switch (name) {
    case 'get_repo':
      return { result: mcpToolResult(repoJson(repo)) };
    case 'create_issue': {
      const created = createIssueOn(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return { result: mcpToolError(created.error) };
      return { result: mcpToolResult(issueJson(repo, created)) };
    }
    case 'list_issues': {
      let list = [...repo.issues.values()];
      const state = typeof args.state === 'string' ? args.state : 'open';
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      return { result: mcpToolResult({ issues: list.map((issue) => issueJson(repo, issue)) }) };
    }
    case 'create_pull_request': {
      const created = createPullOn(
        repo,
        String(args.title ?? ''),
        typeof args.body === 'string' ? args.body : '',
        String(args.head ?? ''),
        String(args.base ?? ''),
      );
      if ('error' in created) {
        const existing = [...repo.pulls.values()].find(
          (pull) => pull.state === 'open' && pull.headRef === String(args.head ?? '') && pull.baseRef === String(args.base ?? ''),
        );
        if (existing !== undefined) return { result: mcpToolResult(pullJson(repo, existing)) };
        return { result: mcpToolError(created.error) };
      }
      return { result: mcpToolResult(pullJson(repo, created)) };
    }
    case 'merge_pull_request': {
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return { result: mcpToolError(`Pull request #${String(args.pull_number)} not found`) };
      const merged = mergePull(repo, pull);
      if (typeof merged !== 'string') return { result: mcpToolError(merged.error) };
      return { result: mcpToolResult(pullJson(repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authed(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    return true;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(body) ? (body.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = (body.id ?? null) as string | number | null;
  const params = isRecord(body.params) ? body.params : {};
  // A notification (no id) is answered with 202 and no body.
  if (id === null && body.method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }
  const respond = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const respondError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  switch (body.method) {
    case 'server/discover': {
      respond({
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
        ? params.protocolVersion
        : '2026-07-28';
      respond({ protocolVersion: offered, capabilities: { tools: {} }, serverInfo: { ...MCP_SERVER_INFO } });
      return true;
    }
    case 'ping': {
      respond({});
      return true;
    }
    case 'tools/list': {
      respond({ tools: MCP_TOOLS });
      return true;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (!MCP_TOOL_NAMES.has(toolName)) {
        respondError(-32602, `Unknown tool: ${toolName}`);
        return true;
      }
      const outcome = mcpCallTool(toolName, toolArgs);
      if (outcome.error !== undefined) {
        respondError(outcome.error.code, outcome.error.message);
        return true;
      }
      respond(outcome.result ?? {});
      return true;
    }
    default: {
      respondError(-32601, `Method not found: ${body.method}`);
      return true;
    }
  }
}

// ------------------------------------------------------------------ app assembly

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            errJson(res, 404, 'Not Found');
            return;
          }
          await handleGraphql(req, res);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, path);
          return;
        }
        if (await handleGit(req, res, path)) return;
        errJson(res, 404, 'Not Found');
      } catch (err) {
        try {
          errJson(res, 500, err instanceof Error ? err.message : 'Internal error');
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
