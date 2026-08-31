import { Body, Controller, Get, Inject, Put, Query, UseGuards } from '@nestjs/common';
import {
  AuditEventQuerySchema,
  QualityGovernanceQuerySchema,
  UpdateSystemSettingsRequestSchema,
  buildSuccess,
  type ApiResponse,
  type AuditEventListResponse,
  type QualityCostResponse,
  type SystemSettingsResponse,
} from '@knowledge-base/contracts';
import type { AuthContext } from '../auth/auth-context';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { parseRequest } from '../common/validation';
import { SystemGovernanceService } from './system-governance.service';

@Controller('admin')
@UseGuards(AuthenticationGuard)
export class SystemGovernanceController {
  constructor(
    @Inject(SystemGovernanceService) private readonly governance: SystemGovernanceService,
  ) {}

  @Get('settings')
  async settings(@CurrentAuth() auth: AuthContext): Promise<ApiResponse<SystemSettingsResponse>> {
    return buildSuccess(await this.governance.settings(auth));
  }

  @Put('settings')
  async updateSettings(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<SystemSettingsResponse>> {
    return buildSuccess(
      await this.governance.updateSettings(
        auth,
        parseRequest(UpdateSystemSettingsRequestSchema, body),
      ),
    );
  }

  @Get('audit')
  async audit(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<AuditEventListResponse>> {
    return buildSuccess(
      await this.governance.audit(auth, parseRequest(AuditEventQuerySchema, query)),
    );
  }

  @Get('quality')
  async quality(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<QualityCostResponse>> {
    const input = parseRequest(QualityGovernanceQuerySchema, query);
    return buildSuccess(await this.governance.quality(auth, input.days));
  }
}
