import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { buildMinioEndpoint, validateServerEnv, type ServerEnv } from '@knowledge-base/config';
import {
  DOCUMENT_ACL_PROJECTION_QUEUE,
  DOCUMENT_CLEANUP_QUEUE,
  DOCUMENT_INGESTION_QUEUE,
  DOCUMENT_SEARCH_PROJECTION_QUEUE,
} from '@knowledge-base/contracts';
import {
  ChatCitationEntity,
  createDatabaseOptions,
  DocumentAssetEntity,
  DocumentChunkEntity,
  DocumentEntity,
  DocumentSourceAnchorEntity,
  DocumentVersionEntity,
  IngestionJobEntity,
  IngestionStageEntity,
} from '@knowledge-base/database';
import { ObjectStorage } from '@knowledge-base/object-storage';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentIngestionProcessor } from './document-ingestion.processor';
import { DocumentCleanupProcessor } from './document-cleanup.processor';
import { OrphanObjectCleanupService } from './orphan-object-cleanup.service';
import { SearchProjectionService } from './search-projection.service';
import { OBJECT_STORAGE } from './worker.constants';
import { ModelQuotaService } from './model-quota.service';
import { DocumentAclProjectionProcessor } from './document-acl-projection.processor';
import { DocumentSearchProjectionProcessor } from './document-search-projection.processor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateServerEnv }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ServerEnv, true>) => ({
        connection: {
          host: config.getOrThrow('REDIS_HOST'),
          port: config.getOrThrow('REDIS_PORT'),
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ServerEnv, true>) =>
        createDatabaseOptions(config.getOrThrow('DATABASE_URL'), false),
    }),
    TypeOrmModule.forFeature([
      DocumentEntity,
      ChatCitationEntity,
      DocumentAssetEntity,
      DocumentChunkEntity,
      DocumentVersionEntity,
      DocumentSourceAnchorEntity,
      IngestionJobEntity,
      IngestionStageEntity,
    ]),
    BullModule.registerQueue(
      { name: DOCUMENT_INGESTION_QUEUE },
      { name: DOCUMENT_CLEANUP_QUEUE },
      { name: DOCUMENT_ACL_PROJECTION_QUEUE },
      { name: DOCUMENT_SEARCH_PROJECTION_QUEUE },
    ),
  ],
  providers: [
    {
      provide: OBJECT_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ServerEnv, true>) =>
        new ObjectStorage({
          endpoint: buildMinioEndpoint({
            MINIO_ENDPOINT: config.getOrThrow('MINIO_ENDPOINT'),
            MINIO_PORT: config.getOrThrow('MINIO_PORT'),
            MINIO_USE_SSL: config.getOrThrow('MINIO_USE_SSL'),
          }),
          region: config.getOrThrow('MINIO_REGION'),
          accessKeyId: config.getOrThrow('MINIO_ACCESS_KEY'),
          secretAccessKey: config.getOrThrow('MINIO_SECRET_KEY'),
          bucket: config.getOrThrow('MINIO_BUCKET'),
        }),
    },
    DocumentIngestionProcessor,
    DocumentCleanupProcessor,
    DocumentAclProjectionProcessor,
    DocumentSearchProjectionProcessor,
    OrphanObjectCleanupService,
    ModelQuotaService,
    SearchProjectionService,
  ],
})
export class WorkerModule {}
