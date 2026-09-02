import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateServerEnv, type ServerEnv } from '@knowledge-base/config';
import { createDatabaseOptions } from '@knowledge-base/database';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentsModule } from './documents/documents.module';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { StorageModule } from './storage/storage.module';
import { SearchModule } from './search/search.module';
import { AuthModule } from './auth/auth.module';
import { AnswersModule } from './answers/answers.module';
import { ObservabilityModule } from './observability/observability.module';
import { AccessControlModule } from './access-control/access-control.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { SystemGovernanceModule } from './system-governance/system-governance.module';
import { DocumentReviewsModule } from './reviews/document-reviews.module';

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
        createDatabaseOptions(
          config.getOrThrow('DATABASE_URL'),
          config.getOrThrow('DATABASE_MIGRATIONS_RUN'),
        ),
    }),
    StorageModule,
    AuthModule,
    ObservabilityModule,
    HealthModule,
    IngestionModule,
    AccessControlModule,
    KnowledgeModule,
    SystemGovernanceModule,
    DocumentReviewsModule,
    DocumentsModule,
    SearchModule,
    AnswersModule,
  ],
})
export class AppModule {}
