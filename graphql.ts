// graphql.ts — a small GraphQL parser and executor for the exact documents
// `gh` and `github-mcp-server` send: viewer and repository reads, issue and
// pull-request lists and mutations, Relay node(id:), cursor pagination and
// __type introspection, plus batched requests (a JSON array of documents).
//
// Unknown fields answer HTTP 200 with an errors array naming the field;
// an unknown repository answers data.repository = null with no errors.

import { buildCommit, mergeBase, parseCommit, threeWayMerge } from './objects.ts';
import {
  FORGE_IDENT,
  VIEWER_ID,
  VIEWER_LOGIN,
  commentNodeId,
  decodeNodeId,
  issueNodeId,
  nextIso,
  nextTimestamp,
  pullNodeId,
  repoNodeId,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { putObject } from './objects.ts';
import { baseTip, mergeableState, pullFiles } from './rest.ts';

/** The tree a commit holds, or null. */
function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@=&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'int', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- AST

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[];
}

export interface InlineFragmentNode {
  kind: 'inline-fragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

export type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

export interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selection: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: {}, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variables: Record<string, ValueNode | undefined> = {};
        if (this.peek().kind === 'punct' && this.peek().value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.peek().kind === 'punct' && this.peek().value === '=') {
              this.next();
              variables[varName] = this.parseValue();
            } else {
              variables[varName] = undefined;
            }
          }
          this.expectPunct(')');
        }
        this.skipDirectives();
        operations.push({ operation, name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token in GraphQL document: ${JSON.stringify(token)}`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline-fragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (next.kind === 'name') {
          selections.push({ kind: 'spread', name: this.next().value as string });
          this.skipDirectives();
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inline-fragment', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a field name in GraphQL document');
      const first = this.next().value as string;
      let alias: string | null = null;
      let name = first;
      if (this.peek().kind === 'punct' && this.peek().value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
      this.skipDirectives();
      const selection = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- values

/** Resolve a value node against the operation's variables. */
function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

/** The arguments of a field, resolved against the variables. */
function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------- schema (for __type)

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'author',
    'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'url', 'resourcePath',
    'repository', 'viewerCanUpdate', 'locked', 'milestone', 'assignees', 'participants',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'merged',
    'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files',
    'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit',
    'isDraft', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews',
    'url', 'resourcePath', 'repository', 'labels', 'comments',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'url', 'resourcePath', 'createdAt', 'updatedAt',
    'isPrivate', 'isFork', 'forkCount', 'stargazerCount', 'watchers', 'labels',
    'milestones', 'homepageUrl', 'visibility', 'defaultBranch',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'url', 'resourcePath', 'avatarUrl', 'email'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
};

// ---------------------------------------------------------------- executor

interface ExecState {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

/** A value the executor hands around, tagged with its GraphQL type name. */
interface TypedValue {
  type: string;
  value: unknown;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** The cursor for an issue in a connection: its number, base64url-encoded. */
function issueCursor(repo: Repo, issue: Issue): string {
  return Buffer.from(`cursor:${repo.id}:${issue.number}`, 'utf8').toString('base64url');
}

/** The issue number a cursor names, or null. */
function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:\d+:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function executeSelection(
  state: ExecState,
  parent: TypedValue,
  selections: SelectionNode[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = state.fragments.get(selection.name);
      if (fragment !== undefined) {
        Object.assign(out, executeSelection(state, parent, fragment.selection, path));
      }
      continue;
    }
    if (selection.kind === 'inline-fragment') {
      if (selection.typeCondition === null || selection.typeCondition === parent.type) {
        Object.assign(out, executeSelection(state, parent, selection.selection, path));
      }
      continue;
    }
    const field = selection;
    const key = field.alias ?? field.name;
    const result = resolveField(state, parent, field, [...path, key]);
    out[key] = result;
  }
  return out;
}

/** Resolve one field on a typed value; unknown fields record an error and answer null. */
function resolveField(state: ExecState, parent: TypedValue, field: FieldNode, path: Array<string | number>): unknown {
  const args = argsOf(field, state.variables);
  const value = parent.value;
  const fail = (message: string): null => {
    state.errors.push({ message, path });
    return null;
  };

  switch (parent.type) {
    case 'Query': {
      if (field.name === 'viewer') {
        return executeSelection(state, { type: 'User', value: { login: VIEWER_LOGIN, id: VIEWER_ID } }, field.selection, path);
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = owner === VIEWER_LOGIN ? state.store.repo(owner, name) : null;
        if (repo === null) return null;
        return executeSelection(state, { type: 'Repository', value: repo }, field.selection, path);
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const decoded = decodeNodeId(id);
        if (decoded === null) return null;
        const repo = [...state.store.allRepos()].find((entry) => entry.id === decoded.repoId) ?? null;
        if (repo === null) return null;
        if (decoded.kind === 'Repository') {
          return executeSelection(state, { type: 'Repository', value: repo }, field.selection, path);
        }
        if (decoded.kind === 'Issue') {
          const issue = state.store.issue(repo, decoded.number);
          if (issue === null) return null;
          return executeSelection(state, { type: 'Issue', value: { repo, issue } }, field.selection, path);
        }
        if (decoded.kind === 'PullRequest') {
          const pull = state.store.pull(repo, decoded.number);
          if (pull === null) return null;
          return executeSelection(state, { type: 'PullRequest', value: { repo, pull } }, field.selection, path);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        return executeSelection(state, { type: '__Type', value: name }, field.selection, path);
      }
      return fail(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repoId = String(input.repositoryId ?? '');
        const decoded = decodeNodeId(repoId);
        const repo = decoded === null ? null : [...state.store.allRepos()].find((entry) => entry.id === decoded.repoId) ?? null;
        if (repo === null) return fail(`createIssue: unknown repositoryId ${repoId}`);
        const title = String(input.title ?? '');
        if (title === '') return fail('createIssue: a title is required');
        const now = nextIso();
        const number = state.store.takeNumber(repo);
        const issue: Issue = {
          kind: 'issue', id: state.store.nextId(), number, title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open', labels: [], userLogin: VIEWER_LOGIN,
          createdAt: now, updatedAt: now, closedAt: null, seq: number, comments: [],
        };
        repo.issues.push(issue);
        return executeSelection(state, { type: 'CreateIssuePayload', value: { repo, issue } }, field.selection, path);
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(String(input.issueId ?? ''));
        const repo = decoded === null ? null : [...state.store.allRepos()].find((entry) => entry.id === decoded.repoId) ?? null;
        const issue = repo === null || decoded === null ? null : state.store.issue(repo, decoded.number);
        if (issue === null) return fail('closeIssue: unknown issueId');
        issue.state = 'closed';
        issue.closedAt = nextIso();
        issue.updatedAt = nextIso();
        return executeSelection(state, { type: 'CloseIssuePayload', value: { repo: repo!, issue } }, field.selection, path);
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(String(input.repositoryId ?? ''));
        const repo = decoded === null ? null : [...state.store.allRepos()].find((entry) => entry.id === decoded.repoId) ?? null;
        if (repo === null) return fail('createPullRequest: unknown repositoryId');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) return fail('createPullRequest: unknown head or base branch');
        const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (duplicate !== undefined) return fail('createPullRequest: a pull request already exists for this head branch');
        const now = nextIso();
        const number = state.store.takeNumber(repo);
        const pull: Pull = {
          kind: 'pull', id: state.store.nextId(), number,
          title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '',
          state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
          headRef: head, baseRef: base, headSha, baseSha, userLogin: VIEWER_LOGIN,
          createdAt: now, updatedAt: now, closedAt: null, seq: number, comments: [],
        };
        repo.pulls.push(pull);
        return executeSelection(state, { type: 'CreatePullRequestPayload', value: { repo, pull } }, field.selection, path);
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(String(input.pullRequestId ?? ''));
        const repo = decoded === null ? null : [...state.store.allRepos()].find((entry) => entry.id === decoded.repoId) ?? null;
        const pull = repo === null || decoded === null ? null : state.store.pull(repo, decoded.number);
        if (pull === null) return fail('mergePullRequest: unknown pullRequestId');
        if (pull.state !== 'open') return fail('mergePullRequest: the pull request is already closed');
        const headTree = commitTree(repo!, pull.headSha);
        const baseSha = baseTip(repo!, pull);
        const baseTree = commitTree(repo!, baseSha);
        if (headTree === null || baseTree === null) return fail('mergePullRequest: the pull request cannot be merged');
        const base = mergeBase(repo!.objects, baseSha, pull.headSha);
        const ancestorTree = base === null ? null : commitTree(repo!, base);
        if (ancestorTree === null) return fail('mergePullRequest: the pull request has no merge base');
        const merged = threeWayMerge(repo!.objects, ancestorTree, headTree, baseTree);
        if (merged.tree === null) return fail('mergePullRequest: the pull request cannot be merged cleanly');
        const timestamp = nextTimestamp();
        const method = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
        const parents = method === 'SQUASH' ? [baseSha] : [baseSha, pull.headSha];
        const message = method === 'SQUASH' ? `${pull.title} (#${pull.number})\n` : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
        const commit = putObject(repo!.objects, 'commit', buildCommit({ tree: merged.tree, parents, message, timestamp, author: FORGE_IDENT, committer: FORGE_IDENT }));
        repo!.refs.set(`refs/heads/${pull.baseRef}`, commit);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = new Date(timestamp * 1000).toISOString();
        pull.mergeCommitSha = commit;
        pull.closedAt = pull.mergedAt;
        pull.updatedAt = nextIso();
        return executeSelection(state, { type: 'MergePullRequestPayload', value: { repo: repo!, pull } }, field.selection, path);
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeNodeId(String(input.subjectId ?? ''));
        const repo = decoded === null ? null : [...state.store.allRepos()].find((entry) => entry.id === decoded.repoId) ?? null;
        if (repo === null || decoded === null) return fail('addComment: unknown subjectId');
        const target = decoded.kind === 'Issue'
          ? state.store.issue(repo, decoded.number)
          : decoded.kind === 'PullRequest'
            ? state.store.pull(repo, decoded.number)
            : null;
        if (target === null) return fail('addComment: unknown subjectId');
        const now = nextIso();
        const comment = { id: state.store.nextId(), body: String(input.body ?? ''), userLogin: VIEWER_LOGIN, createdAt: now, updatedAt: now };
        target.comments.push(comment);
        return executeSelection(state, { type: 'AddCommentPayload', value: { repo, number: decoded.number, comment } }, field.selection, path);
      }
      return fail(`Cannot query field "${field.name}" on type "Mutation".`);
    }
    case 'User': {
      const user = value as { login: string; id: number };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return user.id;
      if (field.name === 'name') return user.login;
      return fail(`Cannot query field "${field.name}" on type "User".`);
    }
    case 'Repository': {
      const repo = value as Repo;
      switch (field.name) {
        case 'id': return repoNodeId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return repo.fullName;
        case 'owner': return executeSelection(state, { type: 'User', value: { login: repo.owner, id: VIEWER_ID } }, field.selection, path);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (tip === undefined) return null;
          return executeSelection(state, { type: 'Ref', value: { name: repo.defaultBranch, oid: tip } }, field.selection, path);
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'url': return `https://github.com/${repo.fullName}`;
        case 'issue': {
          const issue = state.store.issue(repo, Number(args.number ?? 0));
          if (issue === null) return null;
          return executeSelection(state, { type: 'Issue', value: { repo, issue } }, field.selection, path);
        }
        case 'issues': {
          const first = typeof args.first === 'number' ? args.first : null;
          const after = typeof args.after === 'string' ? args.after : null;
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          let list = [...repo.issues];
          if (states !== null) {
            const wanted = new Set(states.map((entry) => entry.toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const direction = orderBy?.direction === 'DESC' ? 'desc' : 'asc';
          list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
          const afterNumber = after === null ? null : cursorNumber(after);
          if (afterNumber !== null) list = list.filter((issue) => issue.number > afterNumber);
          const total = list.length;
          const page = first === null ? list : list.slice(0, first);
          const endCursor = page.length === 0 ? null : issueCursor(repo, page[page.length - 1]!);
          return executeSelection(
            state,
            { type: 'IssueConnection', value: { repo, nodes: page, hasNextPage: page.length < total, endCursor } },
            field.selection,
            path,
          );
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : null;
          const list = [...repo.pulls].sort((a, b) => a.seq - b.seq);
          const page = first === null ? list : list.slice(0, first);
          return executeSelection(
            state,
            { type: 'PullRequestConnection', value: { repo, nodes: page, hasNextPage: page.length < list.length, endCursor: null } },
            field.selection,
            path,
          );
        }
        case 'pullRequest': {
          const pull = state.store.pull(repo, Number(args.number ?? 0));
          if (pull === null) return null;
          return executeSelection(state, { type: 'PullRequest', value: { repo, pull } }, field.selection, path);
        }
        default:
          return fail(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    case 'Ref': {
      const ref = value as { name: string; oid: string };
      if (field.name === 'name') return ref.name;
      if (field.name === 'target') return ref.oid;
      return fail(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'Issue': {
      const { repo, issue } = value as { repo: Repo; issue: Issue };
      switch (field.name) {
        case 'id': return issueNodeId(repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.closedAt;
        case 'author': return executeSelection(state, { type: 'User', value: { login: issue.userLogin, id: VIEWER_ID } }, field.selection, path);
        case 'url': return `https://github.com/${repo.fullName}/issues/${issue.number}`;
        default:
          return fail(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    case 'PullRequest': {
      const { repo, pull } = value as { repo: Repo; pull: Pull };
      switch (field.name) {
        case 'id': return pullNodeId(repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return mergeableState(repo, pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return pull.headSha;
        case 'baseRefOid': return baseTip(repo, pull);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'closedAt': return pull.closedAt;
        case 'mergedAt': return pull.mergedAt;
        case 'author': return executeSelection(state, { type: 'User', value: { login: pull.userLogin, id: VIEWER_ID } }, field.selection, path);
        case 'url': return `https://github.com/${repo.fullName}/pull/${pull.number}`;
        case 'files': {
          const first = typeof args.first === 'number' ? args.first : null;
          const files = pullFiles(repo, pull);
          const page = first === null ? files : files.slice(0, first);
          return executeSelection(
            state,
            { type: 'ChangedFileConnection', value: { nodes: page } },
            field.selection,
            path,
          );
        }
        default:
          return fail(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    case 'IssueConnection': {
      const conn = value as { repo: Repo; nodes: Issue[]; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') {
        return conn.nodes.map((issue) => executeSelection(state, { type: 'Issue', value: { repo: conn.repo, issue } }, field.selection, path));
      }
      if (field.name === 'totalCount') return conn.nodes.length;
      if (field.name === 'pageInfo') {
        return executeSelection(state, { type: 'PageInfo', value: { hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } }, field.selection, path);
      }
      return fail(`Cannot query field "${field.name}" on type "IssueConnection".`);
    }
    case 'PullRequestConnection': {
      const conn = value as { repo: Repo; nodes: Pull[]; hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'nodes') {
        return conn.nodes.map((pull) => executeSelection(state, { type: 'PullRequest', value: { repo: conn.repo, pull } }, field.selection, path));
      }
      if (field.name === 'totalCount') return conn.nodes.length;
      if (field.name === 'pageInfo') {
        return executeSelection(state, { type: 'PageInfo', value: { hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } }, field.selection, path);
      }
      return fail(`Cannot query field "${field.name}" on type "PullRequestConnection".`);
    }
    case 'ChangedFileConnection': {
      const conn = value as { nodes: Array<{ path: string }> };
      if (field.name === 'nodes') {
        return conn.nodes.map((file) => executeSelection(state, { type: 'ChangedFile', value: file }, field.selection, path));
      }
      if (field.name === 'totalCount') return conn.nodes.length;
      return fail(`Cannot query field "${field.name}" on type "PullRequestChangedFileConnection".`);
    }
    case 'ChangedFile': {
      const file = value as { path: string };
      if (field.name === 'path') return file.path;
      return fail(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
    }
    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; endCursor: string | null };
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return null;
      return fail(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
    case '__Type': {
      const name = value as string;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return SCHEMA_ENUMS[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        const names = SCHEMA_FIELDS[name] ?? [];
        return names.map((entry) => executeSelection(state, { type: '__Field', value: entry }, field.selection, path));
      }
      if (field.name === 'enumValues') {
        const names = SCHEMA_ENUMS[name] ?? [];
        return names.map((entry) => executeSelection(state, { type: '__EnumValue', value: entry }, field.selection, path));
      }
      if (field.name === 'description') return null;
      return fail(`Cannot query field "${field.name}" on type "__Type".`);
    }
    case '__Field': {
      if (field.name === 'name') return value as string;
      if (field.name === 'description') return null;
      return fail(`Cannot query field "${field.name}" on type "__Field".`);
    }
    case '__EnumValue': {
      if (field.name === 'name') return value as string;
      if (field.name === 'description') return null;
      return fail(`Cannot query field "${field.name}" on type "__EnumValue".`);
    }
    case 'CreateIssuePayload': {
      const payload = value as { repo: Repo; issue: Issue };
      if (field.name === 'issue') {
        return executeSelection(state, { type: 'Issue', value: payload }, field.selection, path);
      }
      if (field.name === 'clientMutationId') return null;
      return fail(`Cannot query field "${field.name}" on type "CreateIssuePayload".`);
    }
    case 'CloseIssuePayload': {
      const payload = value as { repo: Repo; issue: Issue };
      if (field.name === 'issue') {
        return executeSelection(state, { type: 'Issue', value: payload }, field.selection, path);
      }
      if (field.name === 'clientMutationId') return null;
      return fail(`Cannot query field "${field.name}" on type "CloseIssuePayload".`);
    }
    case 'CreatePullRequestPayload': {
      const payload = value as { repo: Repo; pull: Pull };
      if (field.name === 'pullRequest') {
        return executeSelection(state, { type: 'PullRequest', value: payload }, field.selection, path);
      }
      if (field.name === 'clientMutationId') return null;
      return fail(`Cannot query field "${field.name}" on type "CreatePullRequestPayload".`);
    }
    case 'MergePullRequestPayload': {
      const payload = value as { repo: Repo; pull: Pull };
      if (field.name === 'pullRequest') {
        return executeSelection(state, { type: 'PullRequest', value: payload }, field.selection, path);
      }
      if (field.name === 'clientMutationId') return null;
      return fail(`Cannot query field "${field.name}" on type "MergePullRequestPayload".`);
    }
    case 'AddCommentPayload': {
      const payload = value as { repo: Repo; number: number; comment: Comment };
      if (field.name === 'commentEdge') {
        return executeSelection(state, { type: 'CommentEdge', value: payload }, field.selection, path);
      }
      if (field.name === 'clientMutationId') return null;
      return fail(`Cannot query field "${field.name}" on type "AddCommentPayload".`);
    }
    case 'CommentEdge': {
      const payload = value as { repo: Repo; number: number; comment: Comment };
      if (field.name === 'node') {
        return executeSelection(state, { type: 'IssueComment', value: payload }, field.selection, path);
      }
      if (field.name === 'cursor') return null;
      return fail(`Cannot query field "${field.name}" on type "IssueCommentEdge".`);
    }
    case 'IssueComment': {
      const payload = value as { repo: Repo; number: number; comment: Comment };
      if (field.name === 'id') return commentNodeId(payload.repo, payload.number, payload.comment);
      if (field.name === 'body') return payload.comment.body;
      if (field.name === 'author') {
        return executeSelection(state, { type: 'User', value: { login: VIEWER_LOGIN, id: VIEWER_ID } }, field.selection, path);
      }
      return fail(`Cannot query field "${field.name}" on type "IssueComment".`);
    }
    default:
      return fail(`Cannot query field "${field.name}" on type "${parent.type}".`);
  }
}

/** Execute one operation document against the store. */
function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>, fragments: Map<string, FragmentNode>): Record<string, unknown> {
  const state: ExecState = { store, variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(state, { type: rootType, value: {} }, operation.selection, []);
  const out: Record<string, unknown> = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}

/** Run a GraphQL request body (one document, or a batch array) and answer the response body. */
export function executeGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { errors: [{ message: 'a GraphQL document needs a query string' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let parsed: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
    try {
      parsed = new Parser(tokenize(doc.query)).parseDocument();
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'the GraphQL document does not parse' }] };
    }
    if (parsed.operations.length === 0) {
      return { errors: [{ message: 'the GraphQL document holds no operation' }] };
    }
    const operationName = typeof doc.operationName === 'string' ? doc.operationName : null;
    const operation = operationName === null
      ? parsed.operations[0]!
      : parsed.operations.find((entry) => entry.name === operationName) ?? parsed.operations[0]!;
    return executeOperation(store, operation, variables, parsed.fragments);
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
