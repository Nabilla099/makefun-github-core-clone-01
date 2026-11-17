// reply.ts — the one response shape every handler returns, so app.ts can
// write it without knowing which surface produced it.

/** What a handler answers: a status, an optional JSON body or raw bytes. */
export interface Reply {
  status: number;
  /** Extra headers beside content-type and the request id. */
  headers?: Record<string, string>;
  /** The JSON body (serialized by app.ts), when `raw` is absent. */
  body?: unknown;
  /** Raw bytes to write as-is (git answers use this). */
  raw?: Buffer;
  /** The content type for `raw` (default application/json). */
  contentType?: string;
}

/** A JSON reply. */
export function jsonReply(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers };
}

/** A JSON error reply: GitHub's shape is just {"message": "..."}. */
export function errorReply(status: number, message: string): Reply {
  return { status, body: { message } };
}

/** A 204 with no body. */
export function emptyReply(): Reply {
  return { status: 204, body: undefined };
}
