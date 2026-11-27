export interface ApiConfig {
  port: number;
  databaseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`API_PORT must be a valid TCP port, got "${env.API_PORT}"`);
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  return { port, databaseUrl };
}

export interface ImportWorkerConfig {
  /** How often the import worker looks for queued imports; 0 turns it off. */
  pollMs: number;
  /** An import `applying` for longer than this is taken over by another worker. */
  staleAfterSeconds: number;
}

export function loadImportWorkerConfig(env: NodeJS.ProcessEnv = process.env): ImportWorkerConfig {
  const read = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(value >= min && value <= max)) {
      throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
    }
    return value;
  };
  return {
    pollMs: read('IMPORT_WORKER_POLL_MS', 2000, 0, 60_000),
    staleAfterSeconds: read('IMPORT_STALE_AFTER_SECONDS', 600, 30, 86_400),
  };
}

export interface WorkerClientConfig {
  /** Base URL of the forecasting worker (services/worker); null turns reorder runs off. */
  url: string | null;
  /** Bearer token the worker expects (WORKER_SERVICE_TOKEN, at least 32 characters). */
  serviceToken: string | null;
  timeoutMs: number;
}

export function loadWorkerClientConfig(env: NodeJS.ProcessEnv = process.env): WorkerClientConfig {
  const url = env.WORKER_URL || null;
  if (url !== null && !/^https?:\/\/[^\s/]+/.test(url)) {
    throw new Error(`WORKER_URL must be an http(s) URL, got "${url}"`);
  }
  const serviceToken = env.WORKER_SERVICE_TOKEN || null;
  if (serviceToken !== null && serviceToken.length < 32) {
    throw new Error('WORKER_SERVICE_TOKEN must be at least 32 characters');
  }
  const rawTimeout = env.WORKER_TIMEOUT_MS;
  const timeoutMs = rawTimeout ? Number(rawTimeout) : 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error(`WORKER_TIMEOUT_MS must be a whole number from 100 to 120000, got "${rawTimeout}"`);
  }
  return { url: url?.replace(/\/+$/, '') ?? null, serviceToken, timeoutMs };
}
