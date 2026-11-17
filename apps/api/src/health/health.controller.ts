import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

export type CheckStatus = 'up' | 'down';

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: { database: CheckStatus };
}

@Controller('v1/health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pick<Pool, 'query'>) {}

  /** 200 with the report when every check is up, 503 with the same shape otherwise. */
  @Get()
  async check(): Promise<HealthReport> {
    const database = await this.checkDatabase();
    if (database !== 'up') {
      const report: HealthReport = { status: 'degraded', checks: { database } };
      throw new ServiceUnavailableException(report);
    }
    return { status: 'ok', checks: { database } };
  }

  private async checkDatabase(): Promise<CheckStatus> {
    try {
      await this.pool.query('SELECT 1');
      return 'up';
    } catch {
      // The error may contain connection details, so it is not echoed back.
      return 'down';
    }
  }
}
