import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CompleteDocumentUploadRequestSchema,
  CreateDocumentUploadRequestSchema,
  DocumentQuerySchema,
  TenantCommandRequestSchema,
  buildSuccess,
  type ApiResponse,
  type CompleteDocumentUploadResponse,
  type CreateDocumentUploadResponse,
} from '@knowledge-base/contracts';
import { parseRequest } from '../common/validation';
import { AccessPolicyService } from '../auth/access-policy.service';
import type { AuthContext } from '../auth/auth-context';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { DocumentsService } from './documents.service';
import { AccessControlService } from '../access-control/access-control.service';

@Controller('documents')
@UseGuards(AuthenticationGuard)
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly documentsService: DocumentsService,
    @Inject(AccessPolicyService) private readonly accessPolicy: AccessPolicyService,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
  ) {}

  @Post('uploads')
  async createUpload(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<CreateDocumentUploadResponse>> {
    const input = parseRequest(CreateDocumentUploadRequestSchema, body);
    if (input.documentId) await this.accessControl.assertDocumentManage(auth, input.documentId);
    return buildSuccess(
      await this.documentsService.createUpload(
        {
          ...input,
          tenantId: auth.tenantId,
          createdBy: auth.userId,
          principalIds:
            input.principalIds === undefined
              ? undefined
              : this.accessPolicy.documentPrincipals(auth, input.principalIds),
        },
        auth,
      ),
    );
  }

  @Post(':documentId/versions/:versionId/complete')
  async completeUpload(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<CompleteDocumentUploadResponse>> {
    parseRequest(CompleteDocumentUploadRequestSchema, body);
    await this.accessControl.assertDocumentManage(auth, documentId);
    return buildSuccess(await this.documentsService.completeUpload(auth, documentId, versionId));
  }

  @Post(':documentId/versions/:versionId/publish')
  async publishVersion(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<unknown>> {
    parseRequest(TenantCommandRequestSchema, body);
    await this.accessControl.assertDocumentManage(auth, documentId);
    this.accessControl.assertDocumentReview(auth);
    return buildSuccess(await this.documentsService.publishVersion(auth, documentId, versionId));
  }

  @Delete(':documentId')
  async deleteDocument(
    @Param('documentId') documentId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<unknown>> {
    await this.accessControl.assertDocumentManage(auth, documentId);
    return buildSuccess(await this.documentsService.deleteDocument(auth, documentId));
  }

  @Get()
  async findAll(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<unknown>> {
    return buildSuccess(
      await this.documentsService.findAll(
        parseRequest(DocumentQuerySchema, { ...(query as object), tenantId: auth.tenantId }),
        auth.principalIds,
      ),
    );
  }

  @Get(':documentId/versions/:versionId/markdown')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  async getMarkdown(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<string> {
    await this.accessControl.assertDocumentRead(auth, documentId);
    return this.documentsService.getMarkdown(auth.tenantId, documentId, versionId);
  }

  @Get(':documentId')
  async findOne(
    @Param('documentId') documentId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<unknown>> {
    await this.accessControl.assertDocumentRead(auth, documentId);
    return buildSuccess(await this.documentsService.findOne(auth.tenantId, documentId));
  }
}
