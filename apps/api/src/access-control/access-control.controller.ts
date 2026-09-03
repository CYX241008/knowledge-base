import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  AssignDepartmentMembersRequestSchema,
  AssignMemberRolesRequestSchema,
  CreateAccessRoleRequestSchema,
  CreateDepartmentRequestSchema,
  ReplaceDocumentAclRequestSchema,
  UpsertOrganizationMemberRequestSchema,
  buildSuccess,
  type ApiResponse,
  type AccessOverviewResponse,
  type AccessPrincipalDirectoryResponse,
  type ReplaceDocumentAclResponse,
} from '@knowledge-base/contracts';
import type { AuthContext } from '../auth/auth-context';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { parseRequest } from '../common/validation';
import { AccessControlService } from './access-control.service';

@Controller('access')
@UseGuards(AuthenticationGuard)
export class AccessControlController {
  constructor(@Inject(AccessControlService) private readonly access: AccessControlService) {}

  @Get('overview')
  async overview(@CurrentAuth() auth: AuthContext): Promise<ApiResponse<AccessOverviewResponse>> {
    return buildSuccess(await this.access.overview(auth));
  }

  @Get('principals')
  async principals(
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<AccessPrincipalDirectoryResponse>> {
    return buildSuccess(await this.access.principalDirectory(auth));
  }

  @Post('members')
  async upsertMember(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(
      await this.access.upsertMember(
        auth,
        parseRequest(UpsertOrganizationMemberRequestSchema, body),
      ),
    );
  }

  @Post('roles')
  async createRole(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(
      await this.access.createRole(auth, parseRequest(CreateAccessRoleRequestSchema, body)),
    );
  }

  @Delete('roles/:roleId')
  async deleteRole(@Param('roleId') roleId: string, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(await this.access.deleteRole(auth, roleId));
  }

  @Put('members/:userId/roles')
  async assignMemberRoles(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    return buildSuccess(
      await this.access.assignMemberRoles(
        auth,
        userId,
        parseRequest(AssignMemberRolesRequestSchema, body),
      ),
    );
  }

  @Post('departments')
  async createDepartment(@Body() body: unknown, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(
      await this.access.createDepartment(auth, parseRequest(CreateDepartmentRequestSchema, body)),
    );
  }

  @Put('departments/:departmentId/members')
  async assignDepartmentMembers(
    @Param('departmentId') departmentId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    return buildSuccess(
      await this.access.assignDepartmentMembers(
        auth,
        departmentId,
        parseRequest(AssignDepartmentMembersRequestSchema, body),
      ),
    );
  }

  @Put('documents/:documentId/acl')
  async replaceDocumentAcl(
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<ReplaceDocumentAclResponse>> {
    const input = parseRequest(ReplaceDocumentAclRequestSchema, body);
    const grants =
      input.grants ??
      (input.principalIds ?? []).map((principalId) => ({
        principalId,
        permissions: ['documents.read' as const],
      }));
    return buildSuccess(await this.access.replaceDocumentAcl(auth, documentId, grants));
  }
}
