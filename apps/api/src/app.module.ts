import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { OrganizationsModule } from './organizations/organizations.module';

@Module({
  imports: [DatabaseModule, OrganizationsModule],
  controllers: [HealthController],
})
export class AppModule {}
