import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { HealthController } from './health.controller';
import { ModelContractService } from './model-contract.service';

@Module({
  imports: [IngestionModule],
  controllers: [HealthController],
  providers: [ModelContractService],
})
export class HealthModule {}
