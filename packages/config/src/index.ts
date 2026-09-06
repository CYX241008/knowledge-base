import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (value.toLowerCase() === 'true' || value === '1') return true;
  if (value.toLowerCase() === 'false' || value === '0') return false;
  return value;
}, z.boolean());

const ServerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    WEB_ORIGIN: z.string().url().default('http://localhost:3002'),
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_URL: z.string().url().optional(),
    DATABASE_URL: z
      .string()
      .min(1)
      .default('postgresql://knowledge:knowledge@localhost:5432/knowledge_base'),
    DATABASE_MIGRATIONS_RUN: booleanFromEnv.default(true),
    MINIO_ENDPOINT: z.string().min(1).default('localhost'),
    MINIO_PORT: z.coerce.number().int().positive().default(9000),
    MINIO_USE_SSL: booleanFromEnv.default(false),
    MINIO_ACCESS_KEY: z.string().min(1).default('minioadmin'),
    MINIO_SECRET_KEY: z.string().min(1).default('minioadmin'),
    MINIO_BUCKET: z.string().min(3).default('knowledge-base'),
    MINIO_REGION: z.string().min(1).default('us-east-1'),
    MAX_UPLOAD_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
    ORPHAN_CLEANUP_ENABLED: booleanFromEnv.default(false),
    ORPHAN_CLEANUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(6 * 60 * 60 * 1_000),
    ORPHAN_OBJECT_GRACE_HOURS: z.coerce.number().int().min(1).default(24),
    ELASTICSEARCH_URL: z.string().url().default('http://localhost:9200'),
    ELASTICSEARCH_INDEX: z.string().trim().min(1).default('knowledge-document-chunks-v1'),
    MODEL_PROVIDER: z.enum(['local', 'openai-compatible']).default('local'),
    MODEL_BASE_URL: z.string().url().optional(),
    MODEL_API_KEY: z.string().min(1).optional(),
    MODEL_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
    MODEL_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
    MODEL_MAX_QUEUE_SIZE: z.coerce.number().int().min(0).max(10_000).default(100),
    MODEL_INTERACTIVE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
    MODEL_INTERACTIVE_MAX_QUEUE_SIZE: z.coerce.number().int().min(0).max(10_000).default(100),
    MODEL_BATCH_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
    MODEL_BATCH_MAX_QUEUE_SIZE: z.coerce.number().int().min(0).max(10_000).default(20),
    MODEL_REQUESTS_PER_MINUTE: z.coerce.number().int().min(0).default(600),
    MODEL_GLOBAL_TOKENS_PER_MINUTE: z.coerce.number().int().min(0).default(0),
    MODEL_TENANT_TOKENS_PER_MINUTE: z.coerce.number().int().min(0).default(0),
    MODEL_USER_TOKENS_PER_MINUTE: z.coerce.number().int().min(0).default(0),
    MODEL_EMBEDDING_TOKENS_PER_MINUTE: z.coerce.number().int().min(0).default(0),
    MODEL_CHAT_TOKENS_PER_MINUTE: z.coerce.number().int().min(0).default(0),
    MODEL_RERANK_TOKENS_PER_MINUTE: z.coerce.number().int().min(0).default(0),
    MODEL_RATE_LIMIT_BACKEND: z.enum(['local', 'redis']).default('local'),
    MODEL_RATE_LIMIT_NAMESPACE: z.string().trim().min(1).default('knowledge-base'),
    MODEL_RATE_LIMIT_FAIL_OPEN: booleanFromEnv.default(false),
    MODEL_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    MODEL_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(250),
    MODEL_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
    MODEL_CIRCUIT_RESET_MS: z.coerce.number().int().min(1_000).default(30_000),
    MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS: z.coerce.number().int().min(1).max(20).default(1),
    MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD: z.coerce.number().int().min(1).max(100).default(2),
    MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(90_000),
    MODEL_STREAM_INCLUDE_USAGE: booleanFromEnv.default(true),
    MODEL_TOKENIZER_ENCODING: z
      .enum(['gpt2', 'r50k_base', 'p50k_base', 'p50k_edit', 'cl100k_base', 'o200k_base'])
      .default('o200k_base'),
    MODEL_INPUT_COST_PER_MILLION_TOKENS: z.coerce.number().min(0).default(0),
    MODEL_OUTPUT_COST_PER_MILLION_TOKENS: z.coerce.number().min(0).default(0),
    MODEL_PRICING_JSON: z.string().default('{}'),
    MODEL_MAX_CALL_COST_USD: z.coerce.number().min(0).default(0),
    MODEL_BUDGET_ALERT_THRESHOLDS: z.string().default('70,90,100'),
    MODEL_BUDGET_TIMEZONE_OFFSET_MINUTES: z.coerce.number().int().min(-720).max(840).default(0),
    MODEL_VALIDATE_ON_STARTUP: booleanFromEnv.default(false),
    EMBEDDING_MODEL: z.string().trim().min(1).default('local-hash-v1'),
    EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(384),
    EMBEDDING_BATCH_MAX_INPUTS: z.coerce.number().int().min(1).max(2_048).default(64),
    EMBEDDING_BATCH_MAX_TOKENS: z.coerce.number().int().min(1_000).default(50_000),
    DOCUMENT_MAX_CHUNKS: z.coerce.number().int().min(1).default(10_000),
    PDF_OCR_PROVIDER: z.enum(['disabled', 'tesseract']).default('disabled'),
    PDF_OCR_LANGUAGES: z.string().trim().min(1).default('eng,chi_sim'),
    PDF_OCR_LANG_PATH: z.string().trim().min(1).optional(),
    PDF_OCR_CACHE_PATH: z.string().trim().min(1).default('.tmp/tesseract-cache'),
    PDF_OCR_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(100),
    PDF_OCR_RENDER_WIDTH: z.coerce.number().int().min(800).max(4_000).default(1_800),
    PDF_OCR_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(120_000),
    PDF_OCR_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(40),
    PDF_NATIVE_TEXT_MIN_CHARACTERS: z.coerce.number().int().min(1).default(40),
    PDF_HEADER_FOOTER_MIN_PAGE_RATIO: z.coerce.number().min(0.5).max(1).default(0.6),
    PDF_VISION_PROVIDER: z.enum(['disabled', 'openai-compatible']).default('disabled'),
    PDF_VISION_MODEL: z.string().trim().min(1).default('gpt-4.1-mini'),
    PDF_VISION_MAX_IMAGES: z.coerce.number().int().min(0).max(500).default(50),
    PDF_VISION_MIN_PIXELS: z.coerce.number().int().min(1).default(40_000),
    PDF_VISION_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(90_000),
    PDF_VISION_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(64).max(4_096).default(300),
    PDF_VISION_DETAIL: z.enum(['low', 'high', 'auto']).default('high'),
    PDF_VISION_REQUIRED_FOR_MIXED_PAGES: booleanFromEnv.default(false),
    PDF_QUALITY_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(75),
    RAG_CONTEXTUAL_RETRIEVAL_ENABLED: booleanFromEnv.default(true),
    CHAT_MODEL: z.string().trim().min(1).default('local-extractive-v1'),
    CHAT_FALLBACK_MODEL: z.string().trim().min(1).optional(),
    CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(128_000).default(1_500),
    CHAT_DEGRADED_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).default(500),
    CHAT_CONTEXT_WINDOW_TOKENS: z.coerce.number().int().min(1_024).default(32_000),
    CHAT_HISTORY_MAX_TOKENS: z.coerce.number().int().min(0).default(2_000),
    CHAT_HISTORY_MAX_MESSAGES: z.coerce.number().int().min(0).max(100).default(12),
    RERANKER_PROVIDER: z.enum(['local', 'http']).default('local'),
    RERANKER_URL: z.string().url().optional(),
    RERANKER_API_KEY: z.string().min(1).optional(),
    RERANKER_MODEL: z.string().trim().min(1).default('local-lexical-v1'),
    RAG_MMR_LAMBDA: z.coerce.number().min(0).max(1).default(0.7),
    RAG_NEAR_DUPLICATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.92),
    RAG_MAX_CONTEXT_CHARACTERS: z.coerce.number().int().min(1_000).default(12_000),
    RAG_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(256).default(8_000),
    RAG_DEGRADED_CONTEXT_TOKENS: z.coerce.number().int().min(128).default(2_000),
    RAG_CONTEXT_SAFETY_TOKENS: z.coerce.number().int().min(0).default(1_000),
    RAG_RERANK_CANDIDATE_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
    RAG_RERANK_MAX_TOKENS: z.coerce.number().int().min(1_000).default(30_000),
    RAG_MAX_CHUNKS_PER_DOCUMENT: z.coerce.number().int().min(1).max(50).default(3),
    RAG_MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.25),
    CHAT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3_650).default(90),
    CHAT_RETENTION_CLEANUP_ENABLED: booleanFromEnv.default(true),
    CHAT_RETENTION_CLEANUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(6 * 60 * 60 * 1_000),
    AUTH_MODE: z.enum(['demo', 'jwt']).default('demo'),
    AUTH_DEMO_TENANT_ID: z.string().uuid().default('11111111-1111-4111-8111-111111111111'),
    AUTH_DEMO_USER_ID: z.string().uuid().default('22222222-2222-4222-8222-222222222222'),
    AUTH_DEMO_PRINCIPAL_IDS: z.string().default(''),
    AUTH_JWT_JWKS_URL: z.string().url().optional(),
    AUTH_JWT_ISSUER: z.string().trim().min(1).optional(),
    AUTH_JWT_AUDIENCE: z.string().trim().min(1).optional(),
    AUTH_JWT_ALGORITHMS: z.string().trim().min(1).default('RS256'),
    AUTH_JWT_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(300).default(5),
    AUTH_JWT_JWKS_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
    AUTH_JWT_JWKS_COOLDOWN_MS: z.coerce.number().int().min(0).default(30_000),
    AUTH_JWT_JWKS_CACHE_MAX_AGE_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .default(10 * 60_000),
    AUTH_JWT_TENANT_CLAIM: z.string().trim().min(1).default('tenant_id'),
    AUTH_JWT_PRINCIPALS_CLAIM: z.string().trim().min(1).default('principal_ids'),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === 'production' && env.AUTH_MODE !== 'jwt') {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'Production requires AUTH_MODE=jwt',
      });
    }
    if (env.NODE_ENV === 'production' && !env.MODEL_VALIDATE_ON_STARTUP) {
      context.addIssue({
        code: 'custom',
        path: ['MODEL_VALIDATE_ON_STARTUP'],
        message: 'Production requires MODEL_VALIDATE_ON_STARTUP=true',
      });
    }
    if (env.NODE_ENV === 'production' && env.MODEL_RATE_LIMIT_BACKEND !== 'redis') {
      context.addIssue({
        code: 'custom',
        path: ['MODEL_RATE_LIMIT_BACKEND'],
        message: 'Production requires MODEL_RATE_LIMIT_BACKEND=redis',
      });
    }
    if (env.AUTH_MODE === 'jwt') {
      for (const key of ['AUTH_JWT_JWKS_URL', 'AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE'] as const) {
        if (!env[key]) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when AUTH_MODE=jwt`,
          });
        }
      }
      const algorithms = env.AUTH_JWT_ALGORITHMS.split(',').map((algorithm) => algorithm.trim());
      if (
        algorithms.some(
          (algorithm) =>
            !['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'].includes(algorithm),
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['AUTH_JWT_ALGORITHMS'],
          message: 'AUTH_JWT_ALGORITHMS contains an unsupported asymmetric algorithm',
        });
      }
    }
    if (env.EMBEDDING_DIMENSIONS !== 384) {
      context.addIssue({
        code: 'custom',
        path: ['EMBEDDING_DIMENSIONS'],
        message: 'Current document_chunk schema requires 384 dimensions',
      });
    }
    if (
      env.MODEL_PROVIDER === 'openai-compatible' ||
      env.PDF_VISION_PROVIDER === 'openai-compatible'
    ) {
      for (const key of ['MODEL_BASE_URL', 'MODEL_API_KEY'] as const) {
        if (!env[key]) {
          context.addIssue({ code: 'custom', path: [key], message: `${key} is required` });
        }
      }
    }
    if (env.RERANKER_PROVIDER === 'http') {
      for (const key of ['RERANKER_URL', 'RERANKER_API_KEY'] as const) {
        if (!env[key]) {
          context.addIssue({ code: 'custom', path: [key], message: `${key} is required` });
        }
      }
    }
  });
export type ServerEnv = z.infer<typeof ServerEnvSchema>;
export function validateServerEnv(input: Record<string, unknown>): ServerEnv {
  return ServerEnvSchema.parse(input);
}

export function buildMinioEndpoint(
  env: Pick<ServerEnv, 'MINIO_ENDPOINT' | 'MINIO_PORT' | 'MINIO_USE_SSL'>,
): string {
  if (/^https?:\/\//i.test(env.MINIO_ENDPOINT)) return env.MINIO_ENDPOINT.replace(/\/$/, '');
  return `${env.MINIO_USE_SSL ? 'https' : 'http'}://${env.MINIO_ENDPOINT}:${env.MINIO_PORT}`;
}

export function buildRedisUrl(
  env: Pick<ServerEnv, 'REDIS_URL' | 'REDIS_HOST' | 'REDIS_PORT'>,
): string {
  return env.REDIS_URL ?? `redis://${env.REDIS_HOST}:${env.REDIS_PORT}`;
}
