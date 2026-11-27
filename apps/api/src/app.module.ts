import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { ImportsModule } from './imports/imports.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { ReordersModule } from './reorders/reorders.module';

@Module({
  imports: [
    DatabaseModule,
    OrganizationsModule,
    CatalogModule,
    InventoryModule,
    ImportsModule,
    PurchasingModule,
    ReordersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
