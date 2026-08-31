import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { buildSuccess, type ApiResponse } from '@knowledge-base/contracts';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { ModelMetricsService } from './model-metrics.service';

@Controller('metrics')
@UseGuards(AuthenticationGuard)
export class MetricsController {
  constructor(@Inject(ModelMetricsService) private readonly modelMetrics: ModelMetricsService) {}

  @Get('models')
  getModelMetrics(): ApiResponse<ReturnType<ModelMetricsService['snapshot']>> {
    return buildSuccess(this.modelMetrics.snapshot());
  }
}
