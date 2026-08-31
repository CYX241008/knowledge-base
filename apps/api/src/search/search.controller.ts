import { Body, Controller, Get, Inject, Post, Query, UseGuards } from '@nestjs/common';
import {
  SearchGovernanceQuerySchema,
  SearchDocumentsRequestSchema,
  SubmitSearchFeedbackRequestSchema,
  buildSuccess,
  type ApiResponse,
  type SearchDocumentsResponse,
  type SearchGovernanceResponse,
  type SearchPreferencesResponse,
  type SubmitSearchFeedbackResponse,
} from '@knowledge-base/contracts';
import { AccessControlService } from '../access-control/access-control.service';
import { parseRequest } from '../common/validation';
import type { AuthContext } from '../auth/auth-context';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { SearchService } from './search.service';
import { SystemGovernanceService } from '../system-governance/system-governance.service';

@Controller('search')
@UseGuards(AuthenticationGuard)
export class SearchController {
  constructor(
    @Inject(SearchService) private readonly searchService: SearchService,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
    @Inject(SystemGovernanceService)
    private readonly systemGovernance: SystemGovernanceService,
  ) {}

  @Post()
  async search(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<SearchDocumentsResponse>> {
    const input = parseRequest(SearchDocumentsRequestSchema, body);
    return buildSuccess(
      await this.searchService.search({
        ...input,
        tenantId: auth.tenantId,
        userId: auth.userId,
        principalIds: auth.principalIds,
        source: 'search',
      }),
    );
  }

  @Get('preferences')
  async preferences(
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<SearchPreferencesResponse>> {
    return buildSuccess(await this.systemGovernance.preferences(auth.tenantId));
  }

  @Post('feedback')
  async feedback(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<SubmitSearchFeedbackResponse>> {
    return buildSuccess(
      await this.systemGovernance.submitFeedback(
        auth,
        parseRequest(SubmitSearchFeedbackRequestSchema, body),
      ),
    );
  }

  @Get('governance')
  async governance(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<SearchGovernanceResponse>> {
    this.accessControl.assertKnowledgeAdministration(auth);
    const input = parseRequest(SearchGovernanceQuerySchema, query);
    return buildSuccess(await this.searchService.governance(auth.tenantId, input.days));
  }
}
