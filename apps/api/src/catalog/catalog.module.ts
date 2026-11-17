import { Module } from '@nestjs/common';
import { CatalogRepository } from './catalog.repository';

@Module({
  providers: [CatalogRepository],
  exports: [CatalogRepository],
})
export class CatalogModule {}
