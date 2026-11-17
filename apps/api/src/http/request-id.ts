import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Caller-supplied ids are kept only when they are short and harmless to log. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export type RequestWithId = Request & { requestId?: string };

/**
 * Gives every request a correlation id: the caller's `X-Request-Id` when it is
 * safe to reuse, a new UUID otherwise. The id is echoed in the response header
 * and in error envelopes, so a failed call can be matched to server logs.
 */
export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}
