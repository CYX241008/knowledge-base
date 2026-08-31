import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { SystemGovernanceController } from './system-governance.controller';
import { SystemGovernanceService } from './system-governance.service';

@Module({
  imports: [AccessControlModule],
  controllers: [SystemGovernanceController],
  providers: [SystemGovernanceService],
  exports: [SystemGovernanceService],
})
export class SystemGovernanceModule {}
