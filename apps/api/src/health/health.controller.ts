import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
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

  /**
   * 200 with the report when every check is up, 503 with the same shape
   * otherwise. The status is set directly (not thrown) so monitors always get
   * the report, never the generic error envelope.
   */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const database = await this.checkDatabase();
    if (database !== 'up') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded', checks: { database } };
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
