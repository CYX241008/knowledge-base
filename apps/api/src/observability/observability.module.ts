import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { ModelMetricsService } from './model-metrics.service';
import { ModelQuotaService } from './model-quota.service';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [ModelMetricsService, ModelQuotaService],
  exports: [ModelMetricsService, ModelQuotaService],
})
export class ObservabilityModule {}
