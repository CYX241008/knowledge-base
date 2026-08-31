import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import {
  TenantCommandRequestSchema,
  buildSuccess,
  type ApiResponse,
} from '@knowledge-base/contracts';
import { parseRequest } from '../common/validation';
import type { AuthContext } from '../auth/auth-context';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { IngestionService } from './ingestion.service';

@Controller('ingestion/jobs')
@UseGuards(AuthenticationGuard)
export class IngestionController {
  constructor(@Inject(IngestionService) private readonly ingestionService: IngestionService) {}

  @Get(':jobId')
  async findOne(
    @Param('jobId') jobId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<unknown>> {
    return buildSuccess(await this.ingestionService.findOne(auth.tenantId, jobId));
  }

  @Post(':jobId/retry')
  async retry(
    @Param('jobId') jobId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<unknown>> {
    parseRequest(TenantCommandRequestSchema, body);
    return buildSuccess(await this.ingestionService.retry(auth.tenantId, jobId));
  }

  @Post(':jobId/cancel')
  async cancel(
    @Param('jobId') jobId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<unknown>> {
    parseRequest(TenantCommandRequestSchema, body);
    return buildSuccess(await this.ingestionService.cancel(auth.tenantId, jobId));
  }
}
