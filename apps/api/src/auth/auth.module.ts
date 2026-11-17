import { Module } from '@nestjs/common';
import { AuthRepository } from './auth.repository';
import { TenantGuard } from './tenant.guard';

@Module({
  providers: [AuthRepository, TenantGuard],
  exports: [AuthRepository, TenantGuard],
})
export class AuthModule {}
