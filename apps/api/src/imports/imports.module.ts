import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { loadImportWorkerConfig } from '../config';
import { InventoryModule } from '../inventory/inventory.module';
import { ImportApplier } from './import-apply';
import { IMPORT_WORKER_CONFIG, ImportWorker } from './import-worker';
import { ImportsController } from './imports.controller';
import { ImportsRepository } from './imports.repository';

@Module({
  imports: [AuthModule, InventoryModule],
  controllers: [ImportsController],
  providers: [
    ImportsRepository,
    ImportApplier,
    ImportWorker,
    { provide: IMPORT_WORKER_CONFIG, useFactory: () => loadImportWorkerConfig() },
  ],
  exports: [ImportsRepository],
})
export class ImportsModule {}
