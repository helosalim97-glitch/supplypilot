import 'server-only';
import { redirect } from 'next/navigation';
import { requireToken } from './session';

export interface FieldError {
  field: string;
  message: string;
}

/** A non-2xx answer from the API, carrying its error envelope. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: FieldError[] = [],
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function apiBaseUrl(): string {
  return (process.env.SUPPLYPILOT_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  headers?: Record<string, string>;
  /** Defaults to the signed-in user's token. */
  token?: string;
}

/**
 * Calls the API from the server (the token never reaches the browser).
 * A 401 sends the user back to sign-in; other errors throw ApiRequestError.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = options.token ?? (await requireToken());
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    ...options.headers,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiRequestError(503, 'api_unreachable', 'The SupplyPilot API could not be reached');
  }

  if (response.status === 401 && options.token === undefined) {
    redirect('/sign-in?expired=1');
  }
  if (!response.ok) {
    const envelope = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string; details?: FieldError[]; requestId?: string };
    } | null;
    const error = envelope?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'request_error',
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details ?? [],
      error?.requestId ?? null,
    );
  }
  return (await response.json()) as T;
}

/** `null` for a 404 (unknown id, or another organization's record). */
export async function apiFetchOrNull<T>(path: string): Promise<T | null> {
  try {
    return await apiFetch<T>(path);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}
