import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { ImportWorkerConfig } from '../config';
import { ImportApplier } from './import-apply';
import { ImportsRepository } from './imports.repository';

export const IMPORT_WORKER_CONFIG = Symbol('IMPORT_WORKER_CONFIG');

/**
 * Background job that applies queued imports. The queue is the
 * `import_batches` table itself: every `pollMs` the worker claims the oldest
 * queued batch (SKIP LOCKED, so API instances can each run a worker) and
 * applies batches until none are left. One drain runs at a time per process.
 */
@Injectable()
export class ImportWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ImportWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private stopping = false;

  constructor(
    private readonly imports: ImportsRepository,
    private readonly applier: ImportApplier,
    @Inject(IMPORT_WORKER_CONFIG) private readonly config: ImportWorkerConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.pollMs === 0) {
      this.logger.log('Import worker disabled (IMPORT_WORKER_POLL_MS=0)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.config.pollMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Starts a drain unless one is already running; resolves to the batches applied. */
  tick(): Promise<number> {
    if (!this.running) {
      this.running = this.drain()
        .catch((error: unknown) => {
          this.logger.error(
            'Import worker poll failed',
            error instanceof Error ? error.stack : String(error),
          );
          return 0;
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  /** Applies queued batches one after another until the queue is empty. */
  async drain(): Promise<number> {
    let processed = 0;
    while (!this.stopping) {
      const batch = await this.imports.claimNextBatch(this.config.staleAfterSeconds);
      if (!batch) break;
      this.logger.log(`Applying import ${batch.id} (attempt ${batch.apply.attempts})`);
      const finished = await this.applier.apply(batch);
      if (finished) {
        const { appliedCount, duplicateCount, rejectedCount } = finished.apply;
        this.logger.log(
          `Import ${batch.id} applied: ${appliedCount} applied, ` +
            `${duplicateCount} duplicate, ${rejectedCount} rejected`,
        );
      }
      processed += 1;
    }
    return processed;
  }
}
