import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { ServerEnv } from '@knowledge-base/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<ServerEnv, true>);

  app.enableShutdownHooks();
  app.enableCors({
    origin: config.getOrThrow('WEB_ORIGIN'),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  app.setGlobalPrefix('api');

  const port = config.getOrThrow('API_PORT');
  await app.listen(port);
  console.info(`API listening on http://localhost:${port}/api`);
}

void bootstrap();
