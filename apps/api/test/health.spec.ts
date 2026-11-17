import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PG_POOL } from '../src/database/database.module';
import { HealthController } from '../src/health/health.controller';

async function appWithPool(query: jest.Mock): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [{ provide: PG_POOL, useValue: { query } }],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('GET /v1/health', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('reports ok when the database answers', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    app = await appWithPool(query);

    const res = await request(app.getHttpServer()).get('/v1/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('returns 503 without leaking connection details when the database is down', async () => {
    const query = jest
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED postgres://supplypilot:secret@db:5432'));
    app = await appWithPool(query);

    const res = await request(app.getHttpServer()).get('/v1/health').expect(503);

    expect(res.body).toEqual({ status: 'degraded', checks: { database: 'down' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
