import { Global, Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { MetricsController } from './metrics.controller';
import { ModelMetricsService } from './model-metrics.service';
import { ModelQuotaService } from './model-quota.service';

@Global()
@Module({
  imports: [AccessControlModule],
  controllers: [MetricsController],
  providers: [ModelMetricsService, ModelQuotaService],
  exports: [ModelMetricsService, ModelQuotaService],
})
export class ObservabilityModule {}
