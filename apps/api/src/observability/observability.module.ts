import { Global, Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { MetricsController } from './metrics.controller';
import { ModelMetricsService } from './model-metrics.service';
import { ModelQuotaService } from './model-quota.service';
import { ModelPricingService } from './model-pricing.service';
import { ModelBudgetService } from './model-budget.service';

@Global()
@Module({
  imports: [AccessControlModule],
  controllers: [MetricsController],
  providers: [ModelBudgetService, ModelMetricsService, ModelPricingService, ModelQuotaService],
  exports: [ModelBudgetService, ModelMetricsService, ModelPricingService, ModelQuotaService],
})
export class ObservabilityModule {}
