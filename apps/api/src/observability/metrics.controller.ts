import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { buildSuccess, type ApiResponse } from '@knowledge-base/contracts';
import { AccessControlService } from '../access-control/access-control.service';
import type { AuthContext } from '../auth/auth-context';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { ModelMetricsService } from './model-metrics.service';

@Controller('metrics')
@UseGuards(AuthenticationGuard)
export class MetricsController {
  constructor(
    @Inject(ModelMetricsService) private readonly modelMetrics: ModelMetricsService,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
  ) {}

  @Get('models')
  getModelMetrics(
    @CurrentAuth() auth: AuthContext,
  ): ApiResponse<ReturnType<ModelMetricsService['snapshot']>> {
    this.accessControl.assertSystemAdministration(auth);
    return buildSuccess(this.modelMetrics.snapshot());
  }
}
