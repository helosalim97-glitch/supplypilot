import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PurchasingController } from './purchasing.controller';
import { PurchasingRepository } from './purchasing.repository';

@Module({
  imports: [AuthModule],
  controllers: [PurchasingController],
  providers: [PurchasingRepository],
  exports: [PurchasingRepository],
})
export class PurchasingModule {}
