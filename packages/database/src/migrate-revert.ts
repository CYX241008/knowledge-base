import { createDatabaseDataSource } from './index';

const defaultDatabaseUrl = 'postgresql://knowledge:knowledge@localhost:5432/knowledge_base';

async function revertMigration(): Promise<void> {
  const dataSource = createDatabaseDataSource(process.env.DATABASE_URL ?? defaultDatabaseUrl);
  await dataSource.initialize();
  try {
    await dataSource.undoLastMigration({ transaction: 'all' });
    console.info('Reverted the latest database migration');
  } finally {
    await dataSource.destroy();
  }
}

void revertMigration();
