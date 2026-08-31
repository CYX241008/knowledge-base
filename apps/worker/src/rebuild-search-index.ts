import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SearchProjectionService } from './search-projection.service';
import { WorkerModule } from './worker.module';

async function rebuild(): Promise<void> {
  const tenantId = process.argv.slice(2).find((argument) => argument !== '--');
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(SearchProjectionService).rebuildAll(tenantId);
    console.info(JSON.stringify({ tenantId: tenantId ?? null, ...result }));
  } finally {
    await app.close();
  }
}

void rebuild();
