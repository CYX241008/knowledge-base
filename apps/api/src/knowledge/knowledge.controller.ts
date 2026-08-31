import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  CreateKnowledgeFolderRequestSchema,
  CreateKnowledgeSpaceRequestSchema,
  CreateKnowledgeTagRequestSchema,
  MoveDocumentRequestSchema,
  ReplaceContainerAclRequestSchema,
  ReplaceDocumentTagsRequestSchema,
  UpdateKnowledgeFolderRequestSchema,
  UpdateKnowledgeSpaceRequestSchema,
  UpdateKnowledgeTagRequestSchema,
  buildSuccess,
} from '@knowledge-base/contracts';
import type { AuthContext } from '../auth/auth-context';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { parseRequest } from '../common/validation';
import { KnowledgeService } from './knowledge.service';

@Controller('knowledge')
@UseGuards(AuthenticationGuard)
export class KnowledgeController {
  constructor(@Inject(KnowledgeService) private readonly knowledge: KnowledgeService) {}

  @Get('overview')
  async overview(@CurrentAuth() auth: AuthContext) {
    return buildSuccess(await this.knowledge.overview(auth));
  }

  @Post('spaces')
  async createSpace(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(
      await this.knowledge.createSpace(auth, parseRequest(CreateKnowledgeSpaceRequestSchema, body)),
    );
  }

  @Patch('spaces/:spaceId')
  async updateSpace(
    @Param('spaceId') spaceId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    return buildSuccess(
      await this.knowledge.updateSpace(
        auth,
        spaceId,
        parseRequest(UpdateKnowledgeSpaceRequestSchema, body),
      ),
    );
  }

  @Delete('spaces/:spaceId')
  async deleteSpace(@Param('spaceId') spaceId: string, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(await this.knowledge.deleteSpace(auth, spaceId));
  }

  @Put('spaces/:spaceId/acl')
  async replaceSpaceAcl(
    @Param('spaceId') spaceId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    const input = parseRequest(ReplaceContainerAclRequestSchema, body);
    return buildSuccess(await this.knowledge.replaceSpaceAcl(auth, spaceId, input.principalIds));
  }

  @Post('folders')
  async createFolder(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(
      await this.knowledge.createFolder(
        auth,
        parseRequest(CreateKnowledgeFolderRequestSchema, body),
      ),
    );
  }

  @Patch('folders/:folderId')
  async updateFolder(
    @Param('folderId') folderId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    return buildSuccess(
      await this.knowledge.updateFolder(
        auth,
        folderId,
        parseRequest(UpdateKnowledgeFolderRequestSchema, body),
      ),
    );
  }

  @Delete('folders/:folderId')
  async deleteFolder(@Param('folderId') folderId: string, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(await this.knowledge.deleteFolder(auth, folderId));
  }

  @Put('folders/:folderId/acl')
  async replaceFolderAcl(
    @Param('folderId') folderId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    const input = parseRequest(ReplaceContainerAclRequestSchema, body);
    return buildSuccess(await this.knowledge.replaceFolderAcl(auth, folderId, input.principalIds));
  }

  @Post('tags')
  async createTag(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(
      await this.knowledge.createTag(auth, parseRequest(CreateKnowledgeTagRequestSchema, body)),
    );
  }

  @Delete('tags/:tagId')
  async deleteTag(@Param('tagId') tagId: string, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(await this.knowledge.deleteTag(auth, tagId));
  }

  @Patch('tags/:tagId')
  async updateTag(
    @Param('tagId') tagId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    return buildSuccess(
      await this.knowledge.updateTag(
        auth,
        tagId,
        parseRequest(UpdateKnowledgeTagRequestSchema, body),
      ),
    );
  }

  @Put('documents/:documentId/location')
  async moveDocument(
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    return buildSuccess(
      await this.knowledge.moveDocument(
        auth,
        documentId,
        parseRequest(MoveDocumentRequestSchema, body),
      ),
    );
  }

  @Put('documents/:documentId/tags')
  async replaceDocumentTags(
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    const input = parseRequest(ReplaceDocumentTagsRequestSchema, body);
    return buildSuccess(await this.knowledge.replaceDocumentTags(auth, documentId, input.tagIds));
  }
}
