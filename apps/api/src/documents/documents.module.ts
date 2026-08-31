import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DocumentAssetEntity,
  DocumentEntity,
  DocumentVersionEntity,
} from '@knowledge-base/database';
import { IngestionModule } from '../ingestion/ingestion.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { AccessControlModule } from '../access-control/access-control.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([DocumentAssetEntity, DocumentEntity, DocumentVersionEntity]),
    IngestionModule,
    AccessControlModule,
    KnowledgeModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
