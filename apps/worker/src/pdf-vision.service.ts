import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import { createVisionGateway, type ModelGateway } from '@knowledge-base/model-gateway';
import type {
  PdfVisionEngine,
  PdfVisionInput,
  PdfVisionKind,
  PdfVisionResult,
} from '@knowledge-base/rag';
import { ModelMetricsService } from './model-metrics.service';
import { ModelQuotaService } from './model-quota.service';

@Injectable()
export class PdfVisionService implements PdfVisionEngine {
  private readonly gateway: Pick<ModelGateway, 'analyzeImage'> | null;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(ModelQuotaService) private readonly modelQuota: ModelQuotaService,
    @Inject(ModelMetricsService) private readonly modelMetrics: ModelMetricsService,
  ) {
    this.gateway = createVisionGateway({
      provider:
        this.config.getOrThrow('PDF_VISION_PROVIDER') === 'openai-compatible'
          ? 'openai-compatible'
          : 'local',
      baseUrl: this.config.get('MODEL_BASE_URL'),
      apiKey: this.config.get('MODEL_API_KEY'),
      timeoutMs: this.config.getOrThrow('PDF_VISION_TIMEOUT_MS'),
      maxConcurrency: this.config.getOrThrow('MODEL_BATCH_MAX_CONCURRENCY'),
      maxQueueSize: this.config.getOrThrow('MODEL_BATCH_MAX_QUEUE_SIZE'),
      requestsPerMinute: this.config.getOrThrow('MODEL_REQUESTS_PER_MINUTE'),
      tokenRateLimits: {
        global: this.config.getOrThrow('MODEL_GLOBAL_TOKENS_PER_MINUTE'),
        tenant: this.config.getOrThrow('MODEL_TENANT_TOKENS_PER_MINUTE'),
        user: this.config.getOrThrow('MODEL_USER_TOKENS_PER_MINUTE'),
        model: {
          embedding: this.config.getOrThrow('MODEL_EMBEDDING_TOKENS_PER_MINUTE'),
          chat: this.config.getOrThrow('MODEL_CHAT_TOKENS_PER_MINUTE'),
          rerank: this.config.getOrThrow('MODEL_RERANK_TOKENS_PER_MINUTE'),
        },
      },
      tokenizerEncoding: this.config.getOrThrow('MODEL_TOKENIZER_ENCODING'),
      rateLimiter: this.modelQuota.rateLimiter,
      circuitBreaker: this.modelQuota.circuitBreaker,
      maxRetries: this.config.getOrThrow('MODEL_MAX_RETRIES'),
      retryBaseDelayMs: this.config.getOrThrow('MODEL_RETRY_BASE_DELAY_MS'),
      circuitFailureThreshold: this.config.getOrThrow('MODEL_CIRCUIT_FAILURE_THRESHOLD'),
      circuitResetMs: this.config.getOrThrow('MODEL_CIRCUIT_RESET_MS'),
      circuitHalfOpenMaxRequests: this.config.getOrThrow('MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS'),
      circuitHalfOpenSuccessThreshold: this.config.getOrThrow(
        'MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD',
      ),
      circuitHalfOpenProbeTimeoutMs: this.config.getOrThrow(
        'MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS',
      ),
      includeUsage: this.config.getOrThrow('MODEL_STREAM_INCLUDE_USAGE'),
      onMetric: this.modelMetrics.observe,
    });
  }

  get enabled(): boolean {
    return this.gateway !== null;
  }

  async analyze(input: PdfVisionInput): Promise<PdfVisionResult> {
    if (!this.gateway) throw new Error('PDF vision analysis is disabled');
    const response = await this.gateway.analyzeImage({
      model: this.config.getOrThrow('PDF_VISION_MODEL'),
      prompt: [
        'Analyze this image extracted from a business PDF.',
        'Return JSON only with keys: kind, description, searchable, confidence.',
        'kind must be chart, diagram, table, document, photo, decorative, or other.',
        'description must state the visible facts, labels, values, relationships, and trend without speculation.',
        'Set searchable=false for logos, separators, backgrounds, signatures, or decorative images.',
        input.nearbyText ? `Nearby page text:\n${input.nearbyText}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      image: {
        bytes: input.image,
        mimeType: supportedMimeType(input.mimeType),
        width: input.width,
        height: input.height,
        detail: this.config.getOrThrow('PDF_VISION_DETAIL'),
      },
      maxOutputTokens: this.config.getOrThrow('PDF_VISION_MAX_OUTPUT_TOKENS'),
      context: {
        tenantId: input.tenantId,
        runId: input.runId,
        documentVersionId: input.runId,
        pageNo: input.page,
        assetId: input.figureId,
        toolName: 'inspect_figure',
        source: 'ingestion',
      },
    });
    return parseVisionResult(response);
  }
}

function parseVisionResult(value: string): PdfVisionResult {
  const json = value.match(/\{[\s\S]*\}/u)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
      if (description) {
        return {
          kind: visionKind(parsed.kind),
          description,
          searchable: parsed.searchable !== false,
          ...(typeof parsed.confidence === 'number'
            ? { confidence: Math.max(0, Math.min(100, parsed.confidence)) }
            : {}),
        };
      }
    } catch {
      // Fall through to a plain-text description for compatible providers.
    }
  }
  return {
    kind: 'other',
    description: value.trim(),
    searchable: Boolean(value.trim()),
  };
}

function visionKind(value: unknown): PdfVisionKind {
  return ['chart', 'diagram', 'table', 'document', 'photo', 'decorative', 'other'].includes(
    String(value),
  )
    ? (value as PdfVisionKind)
    : 'other';
}

function supportedMimeType(value: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
  if (value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value;
  return 'image/png';
}
