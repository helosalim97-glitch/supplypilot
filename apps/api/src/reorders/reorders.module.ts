import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { loadWorkerClientConfig } from '../config';
import { PurchasingModule } from '../purchasing/purchasing.module';
import { HttpReorderCandidateSource, ReorderCandidateSource } from './reorder-worker.client';
import { ReordersController } from './reorders.controller';
import { ReordersRepository } from './reorders.repository';

@Module({
  imports: [AuthModule, PurchasingModule],
  controllers: [ReordersController],
  providers: [
    ReordersRepository,
    {
      provide: ReorderCandidateSource,
      useFactory: () => new HttpReorderCandidateSource(loadWorkerClientConfig()),
    },
  ],
})
export class ReordersModule {}
