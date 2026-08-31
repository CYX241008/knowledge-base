import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { buildSuccess, type ApiResponse, type HealthResponse } from '@knowledge-base/contracts';
import { ObjectStorage } from '@knowledge-base/object-storage';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import { DataSource } from 'typeorm';
import { IngestionService } from '../ingestion/ingestion.service';
import { OBJECT_STORAGE } from '../storage/storage.constants';
import { ModelContractService } from './model-contract.service';
import { ModelQuotaService } from '../observability/model-quota.service';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(IngestionService) private readonly ingestionService: IngestionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(ModelContractService)
    private readonly modelContract: ModelContractService,
    @Inject(ModelQuotaService) private readonly modelQuota: ModelQuotaService,
  ) {}

  @Get()
  async health(): Promise<ApiResponse<HealthResponse>> {
    try {
      await Promise.all([
        this.dataSource.query('SELECT 1'),
        this.ingestionService.checkConnection(),
        this.storage.ensureBucket(),
        this.modelContract.ensureValid(),
        this.modelQuota.checkConnection(),
        fetch(`${this.config.getOrThrow('ELASTICSEARCH_URL')}/_cluster/health`).then((response) => {
          if (!response.ok) throw new Error(`Elasticsearch health returned ${response.status}`);
        }),
      ]);
    } catch {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'A required dependency is unavailable',
      });
    }
    return buildSuccess({
      status: 'ok',
      service: 'knowledge-base-api',
      timestamp: new Date().toISOString(),
      dependencies: {
        postgres: 'ok',
        redis: 'ok',
        minio: 'ok',
        elasticsearch: 'ok',
        models: 'ok',
        modelQuota: 'ok',
      },
    });
  }
}
