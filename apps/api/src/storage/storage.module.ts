import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildMinioEndpoint, type ServerEnv } from '@knowledge-base/config';
import { ObjectStorage } from '@knowledge-base/object-storage';
import { OBJECT_STORAGE } from './storage.constants';

@Global()
@Module({
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
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
