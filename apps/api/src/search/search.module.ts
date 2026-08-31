import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { AccessControlModule } from '../access-control/access-control.module';
import { SystemGovernanceModule } from '../system-governance/system-governance.module';

@Module({
  imports: [AccessControlModule, SystemGovernanceModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
