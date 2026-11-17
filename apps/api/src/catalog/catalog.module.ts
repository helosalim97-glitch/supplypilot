import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogController } from './catalog.controller';
import { CatalogRepository } from './catalog.repository';

@Module({
  imports: [AuthModule],
  controllers: [CatalogController],
  providers: [CatalogRepository],
  exports: [CatalogRepository],
})
export class CatalogModule {}
