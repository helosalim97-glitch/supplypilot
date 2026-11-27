import { Logger } from '@nestjs/common';
import { loadWorkerClientConfig, type WorkerClientConfig } from '../config';
import type { ReorderRunSettings, WorkerCandidates } from './reorders.models';
import { InvalidWorkerResponseError, parseWorkerCandidates } from './reorders.validation';

/** The worker isn't configured, can't be reached or gave an unusable answer. */
export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

/** Where reorder runs get their numbers from; replaced by a fake in tests. */
export abstract class ReorderCandidateSource {
  abstract candidates(organizationId: string, settings: ReorderRunSettings): Promise<WorkerCandidates>;
}

/**
 * Calls the forecasting worker's `POST /v1/organizations/:orgId/reorder-candidates`
 * with the shared service token. The worker only reads; this API stores the
 * results. Failures surface as `WorkerUnavailableError` (→ 503) and are logged
 * without the token or response body.
 */
export class HttpReorderCandidateSource extends ReorderCandidateSource {
  private readonly logger = new Logger('ReorderWorkerClient');

  constructor(
    private readonly config: WorkerClientConfig = loadWorkerClientConfig(),
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super();
  }

  async candidates(organizationId: string, settings: ReorderRunSettings): Promise<WorkerCandidates> {
    const { url, serviceToken, timeoutMs } = this.config;
    if (!url || !serviceToken) {
      throw new WorkerUnavailableError('Reorder runs are not configured (WORKER_URL, WORKER_SERVICE_TOKEN)');
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${url}/v1/organizations/${organizationId}/reorder-candidates`, {
        method: 'POST',
        headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(settings),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.logger.warn(`worker request failed: ${(error as Error).name}`);
      throw new WorkerUnavailableError('The forecasting worker could not be reached');
    }
    if (!response.ok) {
      this.logger.warn(`worker answered ${response.status}`);
      throw new WorkerUnavailableError(`The forecasting worker answered ${response.status}`);
    }
    try {
      return parseWorkerCandidates(await response.json(), organizationId);
    } catch (error) {
      const detail = error instanceof InvalidWorkerResponseError ? error.message : 'invalid JSON';
      this.logger.warn(detail);
      throw new WorkerUnavailableError('The forecasting worker gave an unusable answer');
    }
  }
}
