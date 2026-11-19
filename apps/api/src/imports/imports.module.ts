import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportsController } from './imports.controller';
import { ImportsRepository } from './imports.repository';

@Module({
  imports: [AuthModule],
  controllers: [ImportsController],
  providers: [ImportsRepository],
  exports: [ImportsRepository],
})
export class ImportsModule {}
