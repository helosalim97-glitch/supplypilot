import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { InventoryModule } from './inventory/inventory.module';
import { OrganizationsModule } from './organizations/organizations.module';

@Module({
  imports: [DatabaseModule, OrganizationsModule, CatalogModule, InventoryModule],
  controllers: [HealthController],
})
export class AppModule {}
