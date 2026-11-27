import { HttpReorderCandidateSource, WorkerUnavailableError } from '../src/reorders/reorder-worker.client';
import { loadWorkerClientConfig } from '../src/config';

const ORG = '0b7e1c9a-3f2d-4c1e-8a6b-000000000001';
const TOKEN = 's'.repeat(40);
const config = { url: 'http://worker.test:8001', serviceToken: TOKEN, timeoutMs: 1000 };

const body = {
  organizationId: ORG,
  asOf: '2026-11-27T10:00:00Z',
  parameters: {},
  candidates: [],
  skipped: [],
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('HttpReorderCandidateSource', () => {
  it('posts the settings with the service token', async () => {
    const fetchFn = jest.fn(async () => jsonResponse(200, body));
    const source = new HttpReorderCandidateSource(config, fetchFn as unknown as typeof fetch);
    await expect(source.candidates(ORG, { demandWindowDays: 30 })).resolves.toMatchObject({ candidates: [] });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://worker.test:8001/v1/organizations/${ORG}/reorder-candidates`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ demandWindowDays: 30 });
  });

  it.each([
    ['not configured', { ...config, url: null }, async () => jsonResponse(200, body)],
    ['unreachable', config, async () => Promise.reject(new TypeError('fetch failed'))],
    ['an error status', config, async () => jsonResponse(500, { error: { code: 'internal_error' } })],
    ['invalid JSON', config, async () => new Response('<html>', { status: 200 })],
    ['another organization in the answer', config, async () => jsonResponse(200, { ...body, organizationId: 'x' })],
  ])('reports the worker as unavailable when %s', async (_label, cfg, impl) => {
    const source = new HttpReorderCandidateSource(cfg, jest.fn(impl) as unknown as typeof fetch);
    const error = await source.candidates(ORG, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerUnavailableError);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe('loadWorkerClientConfig', () => {
  it('reads the worker settings', () => {
    expect(
      loadWorkerClientConfig({ WORKER_URL: 'http://localhost:8001/', WORKER_SERVICE_TOKEN: TOKEN }),
    ).toEqual({ url: 'http://localhost:8001', serviceToken: TOKEN, timeoutMs: 15_000 });
    expect(loadWorkerClientConfig({})).toEqual({ url: null, serviceToken: null, timeoutMs: 15_000 });
  });

  it('refuses short tokens and bad values', () => {
    expect(() => loadWorkerClientConfig({ WORKER_SERVICE_TOKEN: 'short' })).toThrow(/32 characters/);
    expect(() => loadWorkerClientConfig({ WORKER_URL: 'worker:8001' })).toThrow(/WORKER_URL/);
    expect(() => loadWorkerClientConfig({ WORKER_TIMEOUT_MS: '5' })).toThrow(/WORKER_TIMEOUT_MS/);
  });
});
