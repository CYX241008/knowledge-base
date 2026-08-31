import { createDatabaseDataSource } from './index';

const defaultDatabaseUrl = 'postgresql://knowledge:knowledge@localhost:5432/knowledge_base';

async function migrate(): Promise<void> {
  const dataSource = createDatabaseDataSource(process.env.DATABASE_URL ?? defaultDatabaseUrl);
  await dataSource.initialize();
  try {
    const migrations = await dataSource.runMigrations({ transaction: 'all' });
    console.info(`Applied ${migrations.length} database migration(s)`);
  } finally {
    await dataSource.destroy();
  }
}

void migrate();
