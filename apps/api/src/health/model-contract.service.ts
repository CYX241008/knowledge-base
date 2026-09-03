import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import {
  createChatGateway,
  createEmbeddingGateway,
  createRerankGateway,
  type ModelGateway,
  type RerankGateway,
} from '@knowledge-base/model-gateway';
import { DataSource } from 'typeorm';
import { ModelMetricsService } from '../observability/model-metrics.service';
import { ModelQuotaService } from '../observability/model-quota.service';
import { modelRuntimeOptions } from '../observability/model-runtime-options';

@Injectable()
export class ModelContractService implements OnModuleInit {
  private validation: Promise<void> | null = null;
  private readonly embedding: Pick<ModelGateway, 'embed'>;
  private readonly chat: Pick<ModelGateway, 'streamChat'> | null;
  private readonly reranker: RerankGateway;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(ModelMetricsService) modelMetrics: ModelMetricsService,
    @Inject(ModelQuotaService) modelQuota: ModelQuotaService,
  ) {
    const runtime = modelRuntimeOptions(
      this.config,
      modelMetrics.observe,
      modelQuota.rateLimiter,
      modelQuota.circuitBreaker,
    );
    this.embedding = createEmbeddingGateway({
      provider: this.config.getOrThrow('MODEL_PROVIDER'),
      baseUrl: this.config.get('MODEL_BASE_URL'),
      apiKey: this.config.get('MODEL_API_KEY'),
      dimensions: this.config.getOrThrow('EMBEDDING_DIMENSIONS'),
      timeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
      ...runtime,
    });
    this.chat = createChatGateway({
      provider: this.config.getOrThrow('MODEL_PROVIDER'),
      baseUrl: this.config.get('MODEL_BASE_URL'),
      apiKey: this.config.get('MODEL_API_KEY'),
      timeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
      ...runtime,
    });
    this.reranker = createRerankGateway({
      provider: this.config.getOrThrow('RERANKER_PROVIDER'),
      url: this.config.get('RERANKER_URL'),
      apiKey: this.config.get('RERANKER_API_KEY'),
      timeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
      ...runtime,
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.config.getOrThrow('MODEL_VALIDATE_ON_STARTUP')) await this.ensureValid();
  }

  ensureValid(): Promise<void> {
    this.validation ??= this.validate().catch((error) => {
      this.validation = null;
      throw error;
    });
    return this.validation;
  }

  private async validate(): Promise<void> {
    const dimensions = this.config.getOrThrow('EMBEDDING_DIMENSIONS');
    const [column] = await this.dataSource.query<Array<{ type: string }>>(`
      SELECT format_type(attribute.atttypid, attribute.atttypmod) AS type
      FROM pg_attribute attribute
      INNER JOIN pg_class relation ON relation.oid = attribute.attrelid
      INNER JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relname = 'document_chunk'
        AND attribute.attname = 'embedding'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    `);
    if (column?.type !== `vector(${dimensions})`) {
      throw new Error(
        `Embedding schema mismatch: expected vector(${dimensions}), received ${column?.type ?? 'missing column'}`,
      );
    }
    const [probe] = await this.embedding.embed({
      model: this.config.getOrThrow('EMBEDDING_MODEL'),
      inputs: ['knowledge-base dimension compatibility probe'],
      dimensions,
      context: { source: 'health' },
    });
    if (probe?.length !== dimensions) {
      throw new Error(
        `Embedding model returned ${probe?.length ?? 0} dimensions; expected ${dimensions}`,
      );
    }

    if (this.chat) {
      let output = '';
      for await (const token of this.chat.streamChat({
        model: this.config.getOrThrow('CHAT_MODEL'),
        messages: [
          { role: 'developer', content: 'Return only the word OK.' },
          { role: 'user', content: 'Production readiness probe.' },
        ],
        maxOutputTokens: 16,
        context: { source: 'health' },
      })) {
        output += token;
      }
      if (!output.trim()) throw new Error('Chat model readiness probe returned no content');
    }

    const reranked = await this.reranker.rerank({
      model: this.config.getOrThrow('RERANKER_MODEL'),
      query: 'production readiness',
      documents: [
        { id: 'relevant', text: 'production readiness probe' },
        { id: 'unrelated', text: 'unrelated content' },
      ],
      topN: 1,
      context: { source: 'health' },
    });
    if (reranked.length !== 1) throw new Error('Reranker readiness probe returned no result');
  }
}
