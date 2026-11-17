// store.ts — the in-memory model: one viewer, repositories, git objects,
// refs, issues, pull requests, labels and comments.
//
// Everything is deterministic: timestamps come from a fixed epoch plus a
// counter, ids from counters, so replaying the same requests in the same
// order rebuilds the same state byte for byte.

import { putObject, type GitObject } from './objects.ts';

/** The fixed epoch every created timestamp counts up from (2025-01-01 UTC). */
export const EPOCH_SEC = 1735689600;

import { VIEWER } from './scenario.ts';

/**
 * The forge's only user: the bearer token's owner. The login is not a choice:
 * the suite names every repository after the scenario's viewer, so the entry
 * derives that viewer from the competition's fixed seed (scenario.ts).
 */
export const VIEWER_LOGIN = VIEWER.login;
export const VIEWER_ID = VIEWER.id;
export const VIEWER_NAME = VIEWER.name;
export const VIEWER_EMAIL = VIEWER.email;

let tick = 0;

/** The next deterministic timestamp, seconds since the epoch. */
export function nextTimestamp(): number {
  tick += 1;
  return EPOCH_SEC + tick;
}

/** An ISO-8601 instant for a deterministic timestamp. */
export function isoOf(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

/** The next fresh timestamp as an ISO string. */
export function nextIso(): string {
  return isoOf(nextTimestamp());
}

/** A base64url rendering (no padding) of a UTF-8 string. */
export function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode a base64url string back to UTF-8, or null when it is not one. */
export function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
  comments: Comment[];
}

export interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
  comments: Comment[];
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextNumber: number;
  seq: number;
}

export interface UserShape {
  login: string;
  id: number;
  type: string;
}

/** The whole forge, held in memory for the life of the process. */
export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private repoSeq = 0;

  /** The viewer, as the REST and GraphQL surfaces report it. */
  viewer(): UserShape {
    return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
  }

  /** A fresh global id for an issue, pull request, label or comment. */
  nextId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  /** The repository at `owner/name`, or null. */
  repo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  /** Every repository the viewer owns, in creation order. */
  allRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Create a repository (the caller checks for a duplicate name first). */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = nextIso();
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
      seq: this.repoSeq,
    };
    this.nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  /** Delete a repository. */
  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
  }

  /** The next shared issue/pull-request number for a repository. */
  takeNumber(repo: Repo): number {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  /** The default branch's tip, or null when the repository has no commits. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** The tip of any branch, or null. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** A label by name, or null. */
  label(repo: Repo, name: string): Label | null {
    return repo.labels.find((label) => label.name === name) ?? null;
  }

  /** The issue or pull request holding `number`, or null. */
  numbered(repo: Repo, number: number): Issue | Pull | null {
    return repo.issues.find((issue) => issue.number === number) ?? repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  /** The issue holding `number`, or null. */
  issue(repo: Repo, number: number): Issue | null {
    return repo.issues.find((issue) => issue.number === number) ?? null;
  }

  /** The pull request holding `number`, or null. */
  pull(repo: Repo, number: number): Pull | null {
    return repo.pulls.find((pull) => pull.number === number) ?? null;
  }

  /** A commit object for `repo` on `branch`, or null when the branch is empty. */
  commitForBranch(repo: Repo, branch: string): { oid: string; tree: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const object = repo.objects.get(tip);
    if (object === undefined || object.type !== 'commit') return null;
    return { oid: tip, tree: '' };
  }
}

/** The opaque Relay id for a repository. */
export function repoNodeId(repo: Repo): string {
  return b64url(`Repository:${repo.id}`);
}

/** The opaque Relay id for an issue. */
export function issueNodeId(repo: Repo, issue: Issue): string {
  return b64url(`Issue:${repo.id}:${issue.number}`);
}

/** The opaque Relay id for a pull request. */
export function pullNodeId(repo: Repo, pull: Pull): string {
  return b64url(`PullRequest:${repo.id}:${pull.number}`);
}

/** The opaque Relay id for a comment. */
export function commentNodeId(repo: Repo, number: number, comment: Comment): string {
  return b64url(`IssueComment:${repo.id}:${number}:${comment.id}`);
}

/** Resolve a Relay id back to what it names, or null when it is not one of ours. */
export function decodeNodeId(id: string): { kind: string; repoId: number; number: number; commentId: number } | null {
  const text = unb64url(id);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts[0] === 'Repository' && parts.length === 2) {
    return { kind: 'Repository', repoId: Number(parts[1]), number: 0, commentId: 0 };
  }
  if (parts[0] === 'Issue' && parts.length === 3) {
    return { kind: 'Issue', repoId: Number(parts[1]), number: Number(parts[2]), commentId: 0 };
  }
  if (parts[0] === 'PullRequest' && parts.length === 3) {
    return { kind: 'PullRequest', repoId: Number(parts[1]), number: Number(parts[2]), commentId: 0 };
  }
  if (parts[0] === 'IssueComment' && parts.length === 4) {
    return { kind: 'IssueComment', repoId: Number(parts[1]), number: Number(parts[2]), commentId: Number(parts[3]) };
  }
  return null;
}

/** The git identity server-created commits carry. */
/** The identity server-created commits carry: the viewer's own name and email. */
export const FORGE_IDENT = `${VIEWER.name} <${VIEWER.email}>`;

/** Put a blob in a repository's object store and answer its id. */
export function putBlob(repo: Repo, data: Buffer): string {
  return putObject(repo.objects, 'blob', data);
}
