import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DocumentEntity,
  DocumentTagEntity,
  KnowledgeFolderEntity,
  KnowledgeSpaceEntity,
  KnowledgeTagEntity,
  OutboxEventEntity,
  ResourceAclEntity,
} from '@knowledge-base/database';
import { AccessControlModule } from '../access-control/access-control.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      KnowledgeSpaceEntity,
      KnowledgeFolderEntity,
      KnowledgeTagEntity,
      DocumentTagEntity,
      DocumentEntity,
      ResourceAclEntity,
      OutboxEventEntity,
    ]),
    AccessControlModule,
    IngestionModule,
  ],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
