import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AccessPermissionEntity,
  AccessRoleEntity,
  AppUserEntity,
  DepartmentEntity,
  DepartmentMemberEntity,
  DocumentChunkEntity,
  DocumentEffectivePrincipalEntity,
  DocumentEntity,
  OutboxEventEntity,
  ResourceAclEntity,
  RolePermissionEntity,
  TenantEntity,
  UserRoleEntity,
} from '@knowledge-base/database';
import { IngestionModule } from '../ingestion/ingestion.module';
import { AccessControlController } from './access-control.controller';
import { AccessControlService } from './access-control.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TenantEntity,
      AppUserEntity,
      DepartmentEntity,
      DepartmentMemberEntity,
      AccessRoleEntity,
      AccessPermissionEntity,
      UserRoleEntity,
      RolePermissionEntity,
      ResourceAclEntity,
      DocumentEffectivePrincipalEntity,
      DocumentEntity,
      DocumentChunkEntity,
      OutboxEventEntity,
    ]),
    IngestionModule,
  ],
  controllers: [AccessControlController],
  providers: [AccessControlService],
  exports: [AccessControlService],
})
export class AccessControlModule {}
