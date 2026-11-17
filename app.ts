// app.ts — the HTTP server: routing, auth, request ids and body reading.
//
// Every reply carries a non-empty X-GitHub-Request-Id. REST routes answer
// application/json; git routes answer their smart-HTTP content types. A
// request without a bearer token (or with the wrong one) is a 401, except
// the boot probe, the API root and /meta, which take none. Nothing here ever
// throws out of a request: a failure is a 500, and the process stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { errorReply, type Reply } from './reply.ts';
import * as rest from './rest.ts';
import { Store } from './store.ts';

let requestCounter = 0;

/** Read a request body whole (up to 64 MiB; packs are far smaller). */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024 * 1024) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The request's path segments, percent-decoded, and its query. */
function splitPath(req: IncomingMessage): { segments: string[]; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
    return { segments, query: url.searchParams };
  } catch {
    return { segments: [], query: new URLSearchParams() };
  }
}

/** Whether the request carries the shop token (or any non-empty token when the shop token is unset). */
function authorized(req: IncomingMessage, shopToken: string): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null) return false;
  const token = match[1]!;
  if (shopToken === '') return token !== '';
  return token === shopToken;
}

/** Write one reply: JSON, raw bytes, or an empty 204. */
function sendReply(res: ServerResponse, reply: Reply, requestId: string): void {
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...(reply.headers ?? {}) };
  try {
    if (reply.raw !== undefined) {
      const body = reply.raw;
      res.writeHead(reply.status, {
        'content-type': reply.contentType ?? 'application/json; charset=utf-8',
        'content-length': body.length,
        ...headers,
      });
      res.end(body);
      return;
    }
    if (reply.status === 204 || reply.body === undefined) {
      res.writeHead(reply.status, { ...headers });
      res.end();
      return;
    }
    const text = `${JSON.stringify(reply.body)}\n`;
    res.writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  } catch {
    // The peer went away; nothing more to do.
  }
}

/** The REST context every REST handler receives. */
function restContext(store: Store, req: IncomingMessage, query: URLSearchParams, body: unknown): rest.RestContext {
  const host = req.headers.host ?? '127.0.0.1';
  return { store, origin: `http://${host}`, query, body };
}

/** Dispatch one request to the right surface. */
async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store, shopToken: string): Promise<void> {
  const requestId = `req-${(requestCounter += 1)}`;
  const method = req.method ?? 'GET';
  const { segments, query } = splitPath(req);
  const isAuthed = authorized(req, shopToken);

  const needAuth = (reply: () => Reply): Reply => (isAuthed ? reply() : errorReply(401, 'Bad credentials'));

  // The boot probe takes no token.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendReply(res, { status: 200, body: { ok: true } }, requestId);
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/<service>.
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const tail = segments.slice(2);
    if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
      const service = query.get('service');
      const gitProtocol = req.headers['git-protocol'] ?? null;
      const answer = handleInfoRefs(store, owner, repoName, service, typeof gitProtocol === 'string' ? gitProtocol : null);
      sendReply(res, { status: answer.status, raw: answer.body, contentType: answer.contentType }, requestId);
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
      const body = await readBody(req);
      const answer = handleUploadPack(store, owner, repoName, body);
      sendReply(res, { status: answer.status, raw: answer.body, contentType: answer.contentType }, requestId);
      return;
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
      const body = await readBody(req);
      const answer = handleReceivePack(store, owner, repoName, body);
      sendReply(res, { status: answer.status, raw: answer.body, contentType: answer.contentType }, requestId);
      return;
    }
    sendReply(res, errorReply(404, 'Not Found'), requestId);
    return;
  }

  // GraphQL v4.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendReply(res, errorReply(404, 'Not Found'), requestId);
      return;
    }
    if (!isAuthed) {
      sendReply(res, errorReply(401, 'Bad credentials'), requestId);
      return;
    }
    const raw = await readBody(req);
    let body: unknown = null;
    try {
      body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
    } catch {
      sendReply(res, errorReply(400, 'the request body is not valid JSON'), requestId);
      return;
    }
    const result = executeGraphQL(store, body);
    sendReply(res, { status: result.status, body: result.body }, requestId);
    return;
  }

  // MCP over streamable HTTP.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method === 'DELETE') {
      sendReply(res, { status: 200, body: {} }, requestId);
      return;
    }
    if (method !== 'POST') {
      sendReply(res, errorReply(404, 'Not Found'), requestId);
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(store, raw.toString('utf8'), isAuthed);
    if (result.body === null) {
      sendReply(res, { status: result.status, body: undefined }, requestId);
      return;
    }
    sendReply(res, { status: result.status, body: result.body }, requestId);
    return;
  }

  // REST v3.
  if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
    const tail = segments.slice(2);
    const ctx = (body: unknown): rest.RestContext => restContext(store, req, query, body);

    // The API root and /meta take no token.
    if (method === 'GET' && tail.length === 0) {
      sendReply(res, rest.handleRoot(), requestId);
      return;
    }
    if (method === 'GET' && tail.length === 1 && tail[0] === 'meta') {
      sendReply(res, rest.handleMeta(), requestId);
      return;
    }

    // A JSON body, when the request carries one.
    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          sendReply(res, errorReply(400, 'the request body is not valid JSON'), requestId);
          return;
        }
      }
    }

    const route = (): Reply => {
      // /user and /user/repos.
      if (tail.length === 1 && tail[0] === 'user') {
        if (method === 'GET') return rest.handleUser(ctx(body));
      }
      if (tail.length === 2 && tail[0] === 'user' && tail[1] === 'repos') {
        if (method === 'GET') return rest.handleListUserRepos(ctx(body));
        if (method === 'POST') return rest.handleCreateRepo(ctx(body));
      }
      // /repos/<owner>/<repo> and below.
      if (tail.length >= 3 && tail[0] === 'repos') {
        const owner = tail[1]!;
        const name = tail[2]!;
        const rest_ = tail.slice(3);
        if (rest_.length === 0) {
          if (method === 'GET') return rest.handleGetRepo(ctx(body), owner, name);
          if (method === 'PATCH') return rest.handlePatchRepo(ctx(body), owner, name);
          if (method === 'DELETE') return rest.handleDeleteRepo(ctx(body), owner, name);
        }
        if (rest_.length === 1 && rest_[0] === 'branches' && method === 'GET') {
          return rest.handleListBranches(ctx(body), owner, name);
        }
        if (rest_.length === 2 && rest_[0] === 'branches' && method === 'GET') {
          return rest.handleGetBranch(ctx(body), owner, name, rest_[1]!);
        }
        if (rest_.length === 1 && rest_[0] === 'commits' && method === 'GET') {
          return rest.handleListCommits(ctx(body), owner, name);
        }
        if (rest_.length === 4 && rest_[0] === 'git' && rest_[1] === 'refs' && method === 'GET') {
          return rest.handleGetRef(ctx(body), owner, name, rest_[2]!, rest_[3]!);
        }
        if (rest_.length === 2 && rest_[0] === 'git' && rest_[1] === 'refs' && method === 'POST') {
          return rest.handleCreateRef(ctx(body), owner, name);
        }
        if (rest_.length >= 1 && rest_[0] === 'contents') {
          const path = rest_.slice(1).join('/');
          if (method === 'GET') return rest.handleGetContents(ctx(body), owner, name, path);
          if (method === 'PUT') return rest.handlePutContents(ctx(body), owner, name, path);
          if (method === 'DELETE') return rest.handleDeleteContents(ctx(body), owner, name, path);
        }
        if (rest_.length === 1 && rest_[0] === 'labels') {
          if (method === 'GET') return rest.handleListLabels(ctx(body), owner, name);
          if (method === 'POST') return rest.handleCreateLabel(ctx(body), owner, name);
        }
        if (rest_.length === 1 && rest_[0] === 'issues') {
          if (method === 'GET') return rest.handleListIssues(ctx(body), owner, name);
          if (method === 'POST') return rest.handleCreateIssue(ctx(body), owner, name);
        }
        if (rest_.length === 2 && rest_[0] === 'issues' && /^\d+$/.test(rest_[1]!)) {
          const number = Number(rest_[1]);
          if (method === 'GET') return rest.handleGetIssue(ctx(body), owner, name, number);
          if (method === 'PATCH') return rest.handlePatchIssue(ctx(body), owner, name, number);
        }
        if (rest_.length === 3 && rest_[0] === 'issues' && /^\d+$/.test(rest_[1]!) && rest_[2] === 'comments') {
          const number = Number(rest_[1]);
          if (method === 'GET') return rest.handleListComments(ctx(body), owner, name, number);
          if (method === 'POST') return rest.handleCreateComment(ctx(body), owner, name, number);
        }
        if (rest_.length === 1 && rest_[0] === 'pulls') {
          if (method === 'GET') return rest.handleListPulls(ctx(body), owner, name);
          if (method === 'POST') return rest.handleCreatePull(ctx(body), owner, name);
        }
        if (rest_.length === 2 && rest_[0] === 'pulls' && /^\d+$/.test(rest_[1]!)) {
          const number = Number(rest_[1]);
          if (method === 'GET') return rest.handleGetPull(ctx(body), owner, name, number);
        }
        if (rest_.length === 3 && rest_[0] === 'pulls' && /^\d+$/.test(rest_[1]!) && rest_[2] === 'files' && method === 'GET') {
          return rest.handleListPullFiles(ctx(body), owner, name, Number(rest_[1]));
        }
        if (rest_.length === 3 && rest_[0] === 'pulls' && /^\d+$/.test(rest_[1]!) && rest_[2] === 'merge' && method === 'PUT') {
          return rest.handleMergePull(ctx(body), owner, name, Number(rest_[1]));
        }
      }
      return errorReply(404, 'Not Found');
    };

    sendReply(res, needAuth(route), requestId);
    return;
  }

  sendReply(res, errorReply(404, 'Not Found'), requestId);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(store: Store, shopToken: string): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(req, res, store, shopToken).catch(() => {
      try {
        sendReply(res, errorReply(500, 'Internal Server Error'), `req-${(requestCounter += 1)}`);
      } catch {
        // The peer is gone.
      }
    });
  });
  server.on('error', (error: Error) => {
    process.stderr.write(`[forge] server error: ${error.message}\n`);
  });
  return server;
}
