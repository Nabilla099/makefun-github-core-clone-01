// mcp.ts — the Model Context Protocol endpoint at POST /mcp (Streamable HTTP).
//
// The modern era (2026-07-28): server/discover answers identity, capabilities
// and supportedVersions in one request; every later request is a plain
// JSON-RPC POST. The legacy era is answered too: initialize echoes the
// revision the client offers, and notifications/initialized is a 202.
//
// Tools act on the same store as REST (the implementations call the REST
// handlers directly), so a repository or issue created over MCP is the same
// object over REST, with stable ids.

import {
  handleCreateIssue,
  handleCreatePull,
  handleCreateRepo,
  handleGetIssue,
  handleGetRepo,
  handleListIssues,
  handleMergePull,
  type RestContext,
} from './rest.ts';
import type { Store } from './store.ts';

/** One tool, as tools/list answers it. */
interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
  run: (store: Store, args: Record<string, unknown>) => { ok: boolean; data: unknown; error?: string };
}

/** The tools, in a fixed order: tools/list answers this array byte for byte every time. */
const TOOLS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner (the viewer when omitted).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (store, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (name === '') return { ok: false, data: null, error: 'missing required argument: name' };
      const ctx: RestContext = {
        store,
        origin: '',
        query: new URLSearchParams(),
        body: { name, description: args.description ?? '', private: args.private ?? false },
      };
      const reply = handleCreateRepo(ctx);
      if (reply.status >= 400) return { ok: false, data: null, error: messageOf(reply) };
      return { ok: true, data: reply.body };
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repo = typeof args.repo === 'string' ? args.repo : '';
      if (owner === '' || repo === '') return { ok: false, data: null, error: 'missing required argument: owner or repo' };
      const ctx: RestContext = { store, origin: '', query: new URLSearchParams(), body: null };
      const reply = handleGetRepo(ctx, owner, repo);
      if (reply.status >= 400) return { ok: false, data: null, error: messageOf(reply) };
      return { ok: true, data: reply.body };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repo = typeof args.repo === 'string' ? args.repo : '';
      const title = typeof args.title === 'string' ? args.title : '';
      if (owner === '' || repo === '' || title === '') return { ok: false, data: null, error: 'missing required argument: owner, repo or title' };
      const ctx: RestContext = {
        store,
        origin: '',
        query: new URLSearchParams(),
        body: { title, body: args.body ?? '' },
      };
      const reply = handleCreateIssue(ctx, owner, repo);
      if (reply.status >= 400) return { ok: false, data: null, error: messageOf(reply) };
      return { ok: true, data: reply.body };
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
    run: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repo = typeof args.repo === 'string' ? args.repo : '';
      if (owner === '' || repo === '') return { ok: false, data: null, error: 'missing required argument: owner or repo' };
      const query = new URLSearchParams();
      query.set('state', typeof args.state === 'string' ? args.state : 'all');
      query.set('per_page', '100');
      const ctx: RestContext = { store, origin: '', query, body: null };
      const reply = handleListIssues(ctx, owner, repo);
      if (reply.status >= 400) return { ok: false, data: null, error: messageOf(reply) };
      return { ok: true, data: { issues: reply.body } };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repo = typeof args.repo === 'string' ? args.repo : '';
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (owner === '' || repo === '' || title === '' || head === '' || base === '') {
        return { ok: false, data: null, error: 'missing required argument: owner, repo, title, head or base' };
      }
      const ctx: RestContext = {
        store,
        origin: '',
        query: new URLSearchParams(),
        body: { title, body: args.body ?? '', head, base },
      };
      const reply = handleCreatePull(ctx, owner, repo);
      if (reply.status >= 400) return { ok: false, data: null, error: messageOf(reply) };
      return { ok: true, data: reply.body };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repo = typeof args.repo === 'string' ? args.repo : '';
      const number = Number(args.pull_number);
      if (owner === '' || repo === '' || !Number.isInteger(number)) {
        return { ok: false, data: null, error: 'missing required argument: owner, repo or pull_number' };
      }
      const ctx: RestContext = { store, origin: '', query: new URLSearchParams(), body: { merge_method: 'squash' } };
      const reply = handleMergePull(ctx, owner, repo, number);
      if (reply.status >= 400) return { ok: false, data: null, error: messageOf(reply) };
      return { ok: true, data: reply.body };
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by owner, repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
    run: (store, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repo = typeof args.repo === 'string' ? args.repo : '';
      const number = Number(args.issue_number);
      if (owner === '' || repo === '' || !Number.isInteger(number)) {
        return { ok: false, data: null, error: 'missing required argument: owner, repo or issue_number' };
      }
      const ctx: RestContext = { store, origin: '', query: new URLSearchParams(), body: null };
      const reply = handleGetIssue(ctx, owner, repo, number);
      if (reply.status >= 400) return { ok: false, data: null, error: messageOf(reply) };
      return { ok: true, data: reply.body };
    },
  },
];

/** The message a REST reply carries, for a tool error. */
function messageOf(reply: { body?: unknown }): string {
  if (reply.body !== undefined && typeof reply.body === 'object' && reply.body !== null) {
    const message = (reply.body as Record<string, unknown>).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return 'the request failed';
}

/** The legacy revisions the initialize handshake accepts. */
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The public tools list (descriptions and schemas only). */
function toolsList(): unknown {
  return {
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  };
}

/**
 * Answer one POST /mcp request. `authorized` says whether the request carried
 * the bearer token; tools/call without one is a 401. Returns the HTTP status
 * and the JSON body (null for a 202 with no body).
 */
export function handleMcp(store: Store, rawBody: string, authorized: boolean): { status: number; body: unknown | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = parsed as Record<string, unknown>;
  const id = (request.id ?? null) as string | number | null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const fail = (code: number, message: string): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  // A notification (no id) is answered with 202 and no body.
  if (id === null && method !== '') {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return ok({
      resultType: 'discover',
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = LEGACY_REVISIONS.includes(offered) ? offered : '2025-11-25';
    return ok({
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }

  if (method === 'ping') return ok({});

  if (method === 'tools/list') return ok(toolsList());

  if (method === 'tools/call') {
    if (!authorized) {
      return { status: 401, body: { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } } };
    }
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) return fail(-32601, `unknown tool ${name}`);
    const outcome = tool.run(store, args);
    if (!outcome.ok) {
      return ok({ content: [{ type: 'text', text: outcome.error ?? 'the tool failed' }], isError: true });
    }
    const text = JSON.stringify(outcome.data);
    return ok({ content: [{ type: 'text', text }], structuredContent: outcome.data, isError: false });
  }

  return fail(-32601, `unknown method ${method}`);
}
