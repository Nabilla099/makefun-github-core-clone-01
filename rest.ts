// rest.ts — the REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests.
//
// Shapes follow api.github.com: errors are {"message": "..."}, lists paginate
// with a Link rel="next" header, and every route under /api/v3 except the
// root and /meta needs the bearer token (checked by app.ts before dispatch).

import {
  buildCommit,
  buildTreeFromMap,
  flattenTree,
  isAncestor,
  lineCount,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  putObject,
  threeWayMerge,
  treeDiff,
  ZERO_OID,
} from './objects.ts';
import {
  FORGE_IDENT,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  isoOf,
  nextIso,
  nextTimestamp,
  putBlob,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { emptyReply, errorReply, jsonReply, type Reply } from './reply.ts';

/** What app.ts hands a REST handler: the store, the query and the parsed body. */
export interface RestContext {
  store: Store;
  /** The request's origin (scheme + host), for absolute Link URLs. */
  origin: string;
  query: URLSearchParams;
  /** The parsed JSON body, or null when there was none. */
  body: unknown;
}

/** Whether `value` is a plain object (a JSON body). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field out of a body, or a default. */
function strField(body: unknown, name: string, fallback = ''): string {
  if (!isRecord(body)) return fallback;
  const value = body[name];
  return typeof value === 'string' ? value : fallback;
}

/** A boolean field out of a body, or a default. */
function boolField(body: unknown, name: string, fallback = false): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[name];
  return typeof value === 'boolean' ? value : fallback;
}

/** The page size the query asks for (1..100, default 30). */
function perPage(query: URLSearchParams): number {
  const raw = Number(query.get('per_page'));
  if (!Number.isInteger(raw) || raw < 1) return 30;
  return Math.min(raw, 100);
}

/** The page the query asks for (1-based). */
function pageOf(query: URLSearchParams): number {
  const raw = Number(query.get('page'));
  if (!Number.isInteger(raw) || raw < 1) return 1;
  return raw;
}

/** Slice a list into one page, with a Link header when another page follows. */
function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, path: string): { page: T[]; headers: Record<string, string> } {
  const size = perPage(query);
  const page = pageOf(query);
  const start = (page - 1) * size;
  const slice = items.slice(start, start + size);
  const headers: Record<string, string> = {};
  if (start + size < items.length) {
    const next = new URL(path, origin);
    for (const [key, value] of query) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(size));
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { page: [...slice], headers };
}

// ---------------------------------------------------------------- shapes

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner, VIEWER_ID),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((entry) => entry.name === name);
      return label !== undefined ? labelJson(label) : { id: 0, name, color: 'ededed', description: '' };
    }),
    user: userJson(issue.userLogin, VIEWER_ID),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseTip(repo, pull), label: `${repo.owner}:${pull.baseRef}` },
    user: userJson(pull.userLogin, VIEWER_ID),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.userLogin, VIEWER_ID),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

/** Resolve a repository by owner and name; a foreign owner is a 404, never a 403. */
function findRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.store.repo(owner, name);
}

/** A commit's REST shape, from its stored bytes. */
function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const meta = parseCommit(object.data);
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.+) <([^>]*)> (\d+) \+0000$/.exec(line);
    if (match === null) return { name: line, email: '', date: '' };
    return { name: match[1]!, email: match[2]!, date: isoOf(Number(match[3])) };
  };
  return {
    sha: oid,
    commit: {
      // The stored message ends in a newline; the API presents it without one.
      message: meta.message.replace(/\n$/, ''),
      author: ident(meta.author),
      committer: ident(meta.committer),
    },
    parents: meta.parents.map((parent) => ({ sha: parent })),
    author: userJson(VIEWER_LOGIN, VIEWER_ID),
    committer: userJson(VIEWER_LOGIN, VIEWER_ID),
  };
}

/** Resolve a ref name or oid to a commit tip, or null. */
function resolveTip(repo: Repo, ref: string): string | null {
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(repo.objects, tag) ?? tag;
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

/** The tree a commit holds, or null. */
function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/**
 * The base branch's current tip. A pull request tracks a branch, not the
 * commit the base pointed at when the request was opened: after the base
 * moves (another request merged first), merges, mergeability and file diffs
 * must all read the live tip, or a second merge overwrites the first
 * instead of conflicting with it.
 */
export function baseTip(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

/** Walk a commit's ancestors newest-first (depth-first from the tip). */
function walkCommits(repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return out;
}

/** Whether a pull request can merge cleanly (its three-way merge has no conflicts). */
function mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTree = commitTree(repo, pull.headSha);
  const baseSha = baseTip(repo, pull);
  const baseTree = commitTree(repo, baseSha);
  if (headTree === null || baseTree === null) return 'UNKNOWN';
  const base = mergeBase(repo.objects, baseSha, pull.headSha);
  const ancestorTree = base === null ? null : commitTree(repo, base);
  if (ancestorTree === null) return 'UNKNOWN';
  const merged = threeWayMerge(repo.objects, ancestorTree, headTree, baseTree);
  return merged.tree === null ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------- root, meta, user

export function handleRoot(): Reply {
  return jsonReply(
    200,
    { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

export function handleMeta(): Reply {
  return jsonReply(200, { installed_version: '1.0.0' });
}

export function handleUser(ctx: RestContext): Reply {
  return jsonReply(200, { ...ctx.store.viewer(), name: VIEWER_NAME });
}

// ---------------------------------------------------------------- repositories

export function handleListUserRepos(ctx: RestContext): Reply {
  const repos = ctx.store.allRepos();
  const { page, headers } = paginate(repos, ctx.query, ctx.origin, '/api/v3/user/repos');
  return jsonReply(200, page.map(repoJson), headers);
}

export function handleCreateRepo(ctx: RestContext): Reply {
  const name = strField(ctx.body, 'name');
  if (name === '') return errorReply(422, 'a repository name is required');
  if (ctx.store.repo(VIEWER_LOGIN, name) !== null) {
    return errorReply(422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
  }
  const repo = ctx.store.createRepo(VIEWER_LOGIN, name, strField(ctx.body, 'description'), boolField(ctx.body, 'private'));
  return jsonReply(201, repoJson(repo));
}

export function handleGetRepo(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  return jsonReply(200, repoJson(repo));
}

export function handlePatchRepo(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  if (isRecord(ctx.body)) {
    if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
    if (typeof ctx.body.default_branch === 'string' && ctx.body.default_branch !== '') repo.defaultBranch = ctx.body.default_branch;
  }
  repo.updatedAt = nextIso();
  return jsonReply(200, repoJson(repo));
}

export function handleDeleteRepo(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  ctx.store.deleteRepo(repo);
  return emptyReply();
}

// ---------------------------------------------------------------- branches, commits, refs

export function handleListBranches(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .sort()
    .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! }, protected: false }));
  return jsonReply(200, branches);
}

export function handleGetBranch(ctx: RestContext, owner: string, name: string, branch: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return errorReply(404, 'Not Found');
  return jsonReply(200, { name: branch, commit: { sha: tip }, protected: false });
}

export function handleListCommits(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveTip(repo, ref);
  if (tip === null) return jsonReply(200, []);
  const limit = Math.min(perPage(ctx.query), 100);
  const commits = walkCommits(repo, tip, limit)
    .map((oid) => commitJson(repo, oid))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  return jsonReply(200, commits);
}

export function handleGetRef(ctx: RestContext, owner: string, name: string, refKind: string, refName: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const ref = `refs/${refKind}/${refName}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) return errorReply(404, 'Not Found');
  const object = repo.objects.get(oid);
  return jsonReply(200, { ref, object: { sha: oid, type: object?.type ?? 'commit', url: '' } });
}

export function handleCreateRef(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const ref = strField(ctx.body, 'ref');
  const sha = strField(ctx.body, 'sha');
  if (!ref.startsWith('refs/') || sha === '') return errorReply(422, 'a ref and a sha are required');
  if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
  const object = repo.objects.get(sha);
  if (object === undefined) return errorReply(422, 'the sha names no object in this repository');
  repo.refs.set(ref, sha);
  return jsonReply(201, { ref, object: { sha, type: object.type, url: '' } });
}

// ---------------------------------------------------------------- contents

/** Write one file into a branch's tree and commit it; creates the branch from the default tip when needed. */
function writeContent(
  ctx: RestContext,
  repo: Repo,
  branch: string,
  path: string,
  data: Buffer,
  message: string,
): { commitSha: string; blobSha: string } {
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (tip === null && branch !== repo.defaultBranch) {
      // A brand-new repository: the branch starts empty.
      tip = null;
    }
  }
  const blobSha = putBlob(repo, data);
  const baseTree = tip === null ? null : commitTree(repo, tip);
  const flat = baseTree === null ? new Map() : flattenTree(repo.objects, baseTree);
  flat.set(path, { mode: '100644', oid: blobSha });
  const tree = buildTreeFromMap(repo.objects, flat);
  const timestamp = nextTimestamp();
  const commit = buildCommit({
    tree,
    parents: tip === null ? [] : [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    timestamp,
    author: FORGE_IDENT,
    committer: FORGE_IDENT,
  });
  const commitSha = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha };
}

/** Remove one path from a branch's tree and commit it. */
function deleteContent(ctx: RestContext, repo: Repo, branch: string, path: string, message: string): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  const baseTree = commitTree(repo, tip);
  if (baseTree === null) return null;
  const flat = flattenTree(repo.objects, baseTree);
  if (!flat.has(path)) return null;
  flat.delete(path);
  const tree = buildTreeFromMap(repo.objects, flat);
  const timestamp = nextTimestamp();
  const commit = buildCommit({
    tree,
    parents: [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    timestamp,
    author: FORGE_IDENT,
    committer: FORGE_IDENT,
  });
  const commitSha = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return commitSha;
}

export function handleGetContents(ctx: RestContext, owner: string, name: string, path: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveTip(repo, ref);
  if (tip === null) return errorReply(404, 'Not Found');
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return errorReply(404, 'Not Found');
  const segments = path === '' ? [] : path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return errorReply(404, 'Not Found');
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return errorReply(404, 'Not Found');
    const last = index === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) {
        const dirTree = repo.objects.get(entry.oid);
        if (dirTree === undefined) return errorReply(404, 'Not Found');
        return jsonReply(
          200,
          parseTree(dirTree.data).map((child) => ({
            type: child.mode === '40000' ? 'dir' : 'file',
            name: child.name,
            path: `${path}/${child.name}`,
            sha: child.oid,
            size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
          })),
        );
      }
      current = entry.oid;
      continue;
    }
    if (!last) return errorReply(404, 'Not Found');
    const blob = repo.objects.get(entry.oid);
    if (blob === undefined) return errorReply(404, 'Not Found');
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: entry.name,
      path,
      content: blob.data.toString('base64'),
      sha: entry.oid,
    });
  }
  // The repository root: list its top-level entries.
  const root = repo.objects.get(current);
  if (root === undefined || root.type !== 'tree') return errorReply(404, 'Not Found');
  return jsonReply(
    200,
    parseTree(root.data).map((child) => ({
      type: child.mode === '40000' ? 'dir' : 'file',
      name: child.name,
      path: child.name,
      sha: child.oid,
      size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
    })),
  );
}

export function handlePutContents(ctx: RestContext, owner: string, name: string, path: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  if (path === '') return errorReply(422, 'a file path is required');
  const message = strField(ctx.body, 'message', 'update');
  const content = strField(ctx.body, 'content');
  const branch = strField(ctx.body, 'branch', repo.defaultBranch);
  const sha = isRecord(ctx.body) && typeof ctx.body.sha === 'string' ? ctx.body.sha : null;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  let exists = false;
  let currentSha: string | null = null;
  if (tip !== undefined) {
    const treeOid = commitTree(repo, tip);
    if (treeOid !== null) {
      const flat = flattenTree(repo.objects, treeOid);
      const entry = flat.get(path);
      if (entry !== undefined) {
        exists = true;
        currentSha = entry.oid;
      }
    }
  }
  if (sha !== null && currentSha !== sha) return errorReply(409, 'the sha does not match the current file');
  let data: Buffer;
  try {
    data = Buffer.from(content, 'base64');
  } catch {
    return errorReply(400, 'content is not valid base64');
  }
  const written = writeContent(ctx, repo, branch, path, data, message);
  return jsonReply(exists ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: written.blobSha, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: written.commitSha, message },
  });
}

export function handleDeleteContents(ctx: RestContext, owner: string, name: string, path: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const message = strField(ctx.body, 'message', 'delete');
  const branch = strField(ctx.body, 'branch', repo.defaultBranch);
  const sha = isRecord(ctx.body) && typeof ctx.body.sha === 'string' ? ctx.body.sha : null;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return errorReply(404, 'Not Found');
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) return errorReply(404, 'Not Found');
  const entry = flattenTree(repo.objects, treeOid).get(path);
  if (entry === undefined) return errorReply(404, 'Not Found');
  if (sha !== null && sha !== entry.oid) return errorReply(409, 'the sha does not match the current file');
  const commitSha = deleteContent(ctx, repo, branch, path, message);
  if (commitSha === null) return errorReply(404, 'Not Found');
  return jsonReply(200, { commit: { sha: commitSha, message }, content: null });
}

// ---------------------------------------------------------------- labels

export function handleListLabels(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  return jsonReply(200, repo.labels.map(labelJson));
}

export function handleCreateLabel(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const labelName = strField(ctx.body, 'name');
  if (labelName === '') return errorReply(422, 'a label name is required');
  const existing = ctx.store.label(repo, labelName);
  if (existing !== null) return jsonReply(200, labelJson(existing));
  const label: Label = {
    id: ctx.store.nextId(),
    name: labelName,
    color: strField(ctx.body, 'color', 'ededed'),
    description: strField(ctx.body, 'description'),
  };
  repo.labels.push(label);
  return jsonReply(201, labelJson(label));
}

// ---------------------------------------------------------------- issues

function sortedIssues(repo: Repo, state: string, sortDirection: 'asc' | 'desc'): Issue[] {
  const filtered = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const ordered = [...filtered].sort((a, b) => (sortDirection === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  return ordered;
}

export function handleListIssues(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
  const issues = sortedIssues(repo, state, direction);
  const { page, headers } = paginate(issues, ctx.query, ctx.origin, `/api/v3/repos/${owner}/${name}/issues`);
  return jsonReply(200, page.map((issue) => issueJson(repo, issue)), headers);
}

export function handleCreateIssue(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const title = strField(ctx.body, 'title');
  if (title === '') return errorReply(422, 'a title is required');
  const labels = isRecord(ctx.body) && Array.isArray(ctx.body.labels) ? ctx.body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const label of labels) {
    if (ctx.store.label(repo, label) === null) return errorReply(422, `unknown label ${label}`);
  }
  const now = nextIso();
  const number = ctx.store.takeNumber(repo);
  const issue: Issue = {
    kind: 'issue',
    id: ctx.store.nextId(),
    number,
    title,
    body: strField(ctx.body, 'body'),
    state: 'open',
    labels: [...labels],
    userLogin: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    seq: number,
    comments: [],
  };
  repo.issues.push(issue);
  return jsonReply(201, issueJson(repo, issue));
}

export function handleGetIssue(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const issue = ctx.store.numbered(repo, number);
  if (issue === null) return errorReply(404, 'Not Found');
  if (issue.kind === 'issue') return jsonReply(200, issueJson(repo, issue));
  return jsonReply(200, pullJson(repo, issue));
}

export function handlePatchIssue(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const issue = ctx.store.issue(repo, number);
  if (issue === null) return errorReply(404, 'Not Found');
  if (isRecord(ctx.body)) {
    if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
    if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
    if (ctx.body.state === 'open' || ctx.body.state === 'closed') {
      issue.state = ctx.body.state;
      issue.closedAt = ctx.body.state === 'closed' ? nextIso() : null;
    }
  }
  issue.updatedAt = nextIso();
  return jsonReply(200, issueJson(repo, issue));
}

export function handleListComments(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const target = ctx.store.numbered(repo, number);
  if (target === null) return errorReply(404, 'Not Found');
  return jsonReply(200, target.comments.map(commentJson));
}

export function handleCreateComment(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const target = ctx.store.numbered(repo, number);
  if (target === null) return errorReply(404, 'Not Found');
  const body = strField(ctx.body, 'body');
  if (body === '') return errorReply(422, 'a comment body is required');
  const now = nextIso();
  const comment: Comment = { id: ctx.store.nextId(), body, userLogin: VIEWER_LOGIN, createdAt: now, updatedAt: now };
  target.comments.push(comment);
  return jsonReply(201, commentJson(comment));
}

// ---------------------------------------------------------------- pull requests

function pullFilesOf(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const headTree = commitTree(repo, pull.headSha);
  const baseTree = commitTree(repo, baseTip(repo, pull));
  if (headTree === null || baseTree === null) return [];
  return treeDiff(repo.objects, baseTree, headTree).map((change) => ({
    filename: change.path,
    status: change.status === 'deleted' ? 'removed' : change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
  }));
}

export function handleListPulls(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const state = ctx.query.get('state') ?? 'open';
  const pulls = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  const ordered = [...pulls].sort((a, b) => b.seq - a.seq);
  const { page, headers } = paginate(ordered, ctx.query, ctx.origin, `/api/v3/repos/${owner}/${name}/pulls`);
  return jsonReply(200, page.map((pull) => pullJson(repo, pull)), headers);
}

export function handleCreatePull(ctx: RestContext, owner: string, name: string): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const head = strField(ctx.body, 'head');
  const base = strField(ctx.body, 'base', repo.defaultBranch);
  const title = strField(ctx.body, 'title');
  if (head === '' || title === '') return errorReply(422, 'a head branch and a title are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return errorReply(422, `unknown head branch ${head}`);
  if (baseSha === undefined) return errorReply(422, `unknown base branch ${base}`);
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
  if (duplicate !== undefined) return errorReply(422, 'A pull request already exists for this head branch');
  const now = nextIso();
  const number = ctx.store.takeNumber(repo);
  const pull: Pull = {
    kind: 'pull',
    id: ctx.store.nextId(),
    number,
    title,
    body: strField(ctx.body, 'body'),
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    userLogin: VIEWER_LOGIN,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    seq: number,
    comments: [],
  };
  repo.pulls.push(pull);
  return jsonReply(201, pullJson(repo, pull));
}

export function handleGetPull(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const pull = ctx.store.pull(repo, number);
  if (pull === null) return errorReply(404, 'Not Found');
  return jsonReply(200, pullJson(repo, pull));
}

export function handleListPullFiles(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const pull = ctx.store.pull(repo, number);
  if (pull === null) return errorReply(404, 'Not Found');
  return jsonReply(200, pullFilesOf(repo, pull));
}

export function handleMergePull(ctx: RestContext, owner: string, name: string, number: number): Reply {
  const repo = findRepo(ctx, owner, name);
  if (repo === null) return errorReply(404, 'Not Found');
  const pull = ctx.store.pull(repo, number);
  if (pull === null) return errorReply(404, 'Not Found');
  if (pull.state !== 'open') return errorReply(405, 'the pull request is already closed');
  const method = strField(ctx.body, 'merge_method', 'merge');
  const headTree = commitTree(repo, pull.headSha);
  const baseSha = baseTip(repo, pull);
  const baseTree = commitTree(repo, baseSha);
  if (headTree === null || baseTree === null) return errorReply(405, 'the pull request cannot be merged');
  const base = mergeBase(repo.objects, baseSha, pull.headSha);
  const ancestorTree = base === null ? null : commitTree(repo, base);
  if (ancestorTree === null) return errorReply(405, 'the pull request has no merge base');
  const merged = threeWayMerge(repo.objects, ancestorTree, headTree, baseTree);
  if (merged.tree === null) return errorReply(405, 'the pull request cannot be merged cleanly');
  const timestamp = nextTimestamp();
  const parents = method === 'squash' ? [baseSha] : [baseSha, pull.headSha];
  const message = method === 'squash' ? `${pull.title} (#${pull.number})\n` : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commit = buildCommit({
    tree: merged.tree,
    parents,
    message,
    timestamp,
    author: FORGE_IDENT,
    committer: FORGE_IDENT,
  });
  const commitSha = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOf(timestamp);
  pull.mergeCommitSha = commitSha;
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = nextIso();
  return jsonReply(200, { merged: true, sha: commitSha, message: pull.title });
}

/** The mergeability of a pull request, for the GraphQL surface. */
export function mergeableState(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  return mergeableOf(repo, pull);
}

/** The file diff of a pull request, for the GraphQL surface. */
export function pullFiles(repo: Repo, pull: Pull): Array<{ path: string }> {
  return pullFilesOf(repo, pull).map((file) => ({ path: file.filename }));
}

export { lineCount };
