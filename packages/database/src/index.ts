import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { databaseEntities } from './entities';
import { InitialDocuments1753747200000 } from './migrations/1753747200000-initial-documents';
import { DocumentAssets1753833600000 } from './migrations/1753833600000-document-assets';
import { IngestionReliability1753920000000 } from './migrations/1753920000000-ingestion-reliability';
import { DocumentSearch1754006400000 } from './migrations/1754006400000-document-search';
import { ChatRag1754092800000 } from './migrations/1754092800000-chat-rag';
import { AccessControl1754179200000 } from './migrations/1754179200000-access-control';
import { KnowledgeOrganization1754265600000 } from './migrations/1754265600000-knowledge-organization';
import { SearchGovernance1754352000000 } from './migrations/1754352000000-search-governance';
import { SystemGovernance1754438400000 } from './migrations/1754438400000-system-governance';
import { DocumentReview1754524800000 } from './migrations/1754524800000-document-review';

export * from './entities';

export const databaseMigrations = [
  InitialDocuments1753747200000,
  DocumentAssets1753833600000,
  IngestionReliability1753920000000,
  DocumentSearch1754006400000,
  ChatRag1754092800000,
  AccessControl1754179200000,
  KnowledgeOrganization1754265600000,
  SearchGovernance1754352000000,
  SystemGovernance1754438400000,
  DocumentReview1754524800000,
] as const;

export function createDatabaseOptions(
  databaseUrl: string,
  migrationsRun = false,
): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    entities: [...databaseEntities],
    migrations: [...databaseMigrations],
    migrationsRun,
    synchronize: false,
  };
}

export function createDatabaseDataSource(databaseUrl: string): DataSource {
  return new DataSource(createDatabaseOptions(databaseUrl));
}
