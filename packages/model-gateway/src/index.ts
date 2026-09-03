import {
  LocalModelCircuitBreaker,
  type ModelCircuitBreaker,
  type ModelCircuitBreakerInput,
  type ModelCircuitPermit,
} from './circuit-breaker.js';

export {
  LocalModelCircuitBreaker,
  type ModelCircuitBreaker,
  type ModelCircuitBreakerInput,
  type ModelCircuitDecision,
  type ModelCircuitPermit,
  type ModelCircuitState,
} from './circuit-breaker.js';

export type EmbeddingRequest = {
  model: string;
  inputs: string[];
  dimensions?: number;
  signal?: AbortSignal;
};
export type ChatMessage = {
  role: 'developer' | 'system' | 'user' | 'assistant';
  content: string;
};
export type StreamChatRequest = { model: string; messages: ChatMessage[]; signal?: AbortSignal };

export interface ModelGateway {
  embed(request: EmbeddingRequest): Promise<number[][]>;
  streamChat(request: StreamChatRequest): AsyncIterable<string>;
}

export type RerankRequest = {
  model: string;
  query: string;
  documents: Array<{ id: string; text: string }>;
  topN: number;
  signal?: AbortSignal;
};
export type RerankResult = { id: string; score: number };
export interface RerankGateway {
  rerank(request: RerankRequest): Promise<RerankResult[]>;
}

export const LOCAL_HASH_EMBEDDING_MODEL = 'local-hash-v1';
export const LOCAL_HASH_EMBEDDING_DIMENSIONS = 384;
export const LOCAL_LEXICAL_RERANKER_MODEL = 'local-lexical-v1';

export type ModelOperation = 'embedding' | 'chat' | 'rerank';
export type ModelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};
export type ModelCallMetric = {
  operation: ModelOperation;
  model: string;
  status: 'success' | 'error' | 'cancelled' | 'rejected';
  durationMs: number;
  firstTokenDurationMs?: number;
  attempts: number;
  inputCharacters: number;
  outputCharacters: number;
  usage?: ModelTokenUsage;
};
export type ModelCallObserver = (metric: ModelCallMetric) => void;
export type ModelRateLimitInput = {
  operation: ModelOperation;
  model: string;
  limit: number;
};
export type ModelRateLimitDecision = { allowed: boolean; retryAfterMs?: number };
export interface ModelRateLimiter {
  consume(input: ModelRateLimitInput): Promise<ModelRateLimitDecision>;
}

export type ModelResilienceOptions = {
  maxConcurrency?: number;
  maxQueueSize?: number;
  requestsPerMinute?: number;
  rateLimiter?: ModelRateLimiter;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  circuitBreaker?: ModelCircuitBreaker;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
  circuitHalfOpenMaxRequests?: number;
  circuitHalfOpenSuccessThreshold?: number;
  circuitHalfOpenProbeTimeoutMs?: number;
  onMetric?: ModelCallObserver;
};

export class LocalHashEmbeddingGateway implements Pick<ModelGateway, 'embed'> {
  constructor(private readonly onMetric?: ModelCallObserver) {}

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    const startedAt = Date.now();
    const inputCharacters = request.inputs.reduce((sum, input) => sum + input.length, 0);
    try {
      if (request.signal?.aborted) throw abortError(request.signal.reason);
      if (request.model !== LOCAL_HASH_EMBEDDING_MODEL)
        throw new Error(`Unsupported local embedding model: ${request.model}`);
      if (
        request.dimensions !== undefined &&
        request.dimensions !== LOCAL_HASH_EMBEDDING_DIMENSIONS
      ) {
        throw new Error(`Local embeddings require ${LOCAL_HASH_EMBEDDING_DIMENSIONS} dimensions`);
      }
      const vectors = request.inputs.map((input) => embedText(input));
      emitMetric(this.onMetric, {
        operation: 'embedding',
        model: request.model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        attempts: 1,
        inputCharacters,
        outputCharacters: 0,
      });
      return vectors;
    } catch (error) {
      emitMetric(this.onMetric, {
        operation: 'embedding',
        model: request.model,
        status: isAbortError(error) ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        attempts: 1,
        inputCharacters,
        outputCharacters: 0,
      });
      throw error;
    }
  }
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OpenAICompatibleGatewayOptions = {
  baseUrl: string;
  apiKey: string;
  dimensions?: number;
  timeoutMs?: number;
  fetcher?: Fetcher;
  includeUsage?: boolean;
} & ModelResilienceOptions;

export class OpenAICompatibleModelGateway implements ModelGateway {
  private readonly baseUrl: string;
  private readonly dimensions: number;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetcher;
  private readonly resilience: ResilienceController;

  constructor(private readonly options: OpenAICompatibleGatewayOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.dimensions = options.dimensions ?? LOCAL_HASH_EMBEDDING_DIMENSIONS;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetcher = options.fetcher ?? fetch;
    this.resilience = new ResilienceController(options);
  }

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    const inputCharacters = request.inputs.reduce((sum, input) => sum + input.length, 0);
    const scope = await this.resilience.open({
      operation: 'embedding',
      model: request.model,
      signal: request.signal,
      inputCharacters,
    });
    try {
      const response = await scope.retry(() =>
        this.request(
          '/embeddings',
          {
            method: 'POST',
            body: JSON.stringify({
              model: request.model,
              input: request.inputs,
              dimensions: request.dimensions ?? this.dimensions,
              encoding_format: 'float',
            }),
          },
          request.signal,
        ),
      );
      const payload = (await response.json()) as {
        data?: Array<{ index: number; embedding: number[] }>;
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };
      const vectors = [...(payload.data ?? [])]
        .sort((left, right) => left.index - right.index)
        .map((item) => item.embedding);
      if (vectors.length !== request.inputs.length)
        throw new Error('Embedding response count does not match inputs');
      if (vectors.some((vector) => vector.length !== (request.dimensions ?? this.dimensions)))
        throw new Error('Embedding response dimension does not match configuration');
      await scope.succeed(normalizeUsage(payload.usage));
      return vectors;
    } catch (error) {
      await scope.fail(error);
      throw error;
    }
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    const inputCharacters = request.messages.reduce(
      (sum, message) => sum + message.content.length,
      0,
    );
    const scope = await this.resilience.open({
      operation: 'chat',
      model: request.model,
      signal: request.signal,
      inputCharacters,
    });
    let usage: ModelTokenUsage | undefined;
    let outputCharacters = 0;
    try {
      const response = await scope.retry(() =>
        this.request(
          '/chat/completions',
          {
            method: 'POST',
            body: JSON.stringify({
              model: request.model,
              messages: request.messages,
              stream: true,
              ...(this.options.includeUsage === false
                ? {}
                : { stream_options: { include_usage: true } }),
            }),
          },
          request.signal,
        ),
      );
      if (!response.body) throw new Error('Chat response has no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamCompleted = false;
      while (!streamCompleted) {
        if (request.signal?.aborted) throw abortError(request.signal.reason);
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/u);
        buffer = events.pop() ?? '';
        for (const event of events) {
          const parsed = parseChatEvent(event);
          usage = parsed.usage ?? usage;
          if (parsed.token) {
            scope.markFirstToken();
            outputCharacters += parsed.token.length;
            yield parsed.token;
          }
          if (parsed.done) {
            streamCompleted = true;
            break;
          }
        }
        if (done) break;
      }
      if (buffer.trim() && !streamCompleted) {
        const parsed = parseChatEvent(buffer);
        usage = parsed.usage ?? usage;
        if (parsed.token) {
          scope.markFirstToken();
          outputCharacters += parsed.token.length;
          yield parsed.token;
        }
      }
      await scope.succeed(usage, outputCharacters);
    } catch (error) {
      await scope.fail(error, outputCharacters);
      throw error;
    } finally {
      if (!scope.isClosed()) await scope.fail(abortError(), outputCharacters);
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        ...init.headers,
      },
      signal: combineAbortSignals(callerSignal, AbortSignal.timeout(this.timeoutMs)),
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 1_000);
      throw new ModelHttpError(
        response.status,
        `Model gateway returned ${response.status}: ${details}`,
      );
    }
    return response;
  }
}

export class LocalLexicalRerankGateway implements RerankGateway {
  constructor(private readonly onMetric?: ModelCallObserver) {}

  async rerank(request: RerankRequest): Promise<RerankResult[]> {
    const startedAt = Date.now();
    const inputCharacters =
      request.query.length + request.documents.reduce((sum, item) => sum + item.text.length, 0);
    try {
      if (request.signal?.aborted) throw abortError(request.signal.reason);
      if (request.model !== LOCAL_LEXICAL_RERANKER_MODEL)
        throw new Error(`Unsupported local reranker model: ${request.model}`);
      const queryTokens = new Set(tokenize(request.query));
      const queryWeight = [...queryTokens].reduce((sum, token) => sum + tokenWeight(token), 0);
      const results = request.documents
        .map((document) => {
          const documentTokens = new Set(tokenize(document.text));
          const matchedWeight = [...queryTokens]
            .filter((token) => documentTokens.has(token))
            .reduce((sum, token) => sum + tokenWeight(token), 0);
          return { id: document.id, score: queryWeight === 0 ? 0 : matchedWeight / queryWeight };
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, request.topN);
      emitMetric(this.onMetric, {
        operation: 'rerank',
        model: request.model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        attempts: 1,
        inputCharacters,
        outputCharacters: 0,
      });
      return results;
    } catch (error) {
      emitMetric(this.onMetric, {
        operation: 'rerank',
        model: request.model,
        status: isAbortError(error) ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
        attempts: 1,
        inputCharacters,
        outputCharacters: 0,
      });
      throw error;
    }
  }
}

export type HttpRerankGatewayOptions = {
  url: string;
  apiKey: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
} & ModelResilienceOptions;

export class HttpRerankGateway implements RerankGateway {
  private readonly resilience: ResilienceController;

  constructor(private readonly options: HttpRerankGatewayOptions) {
    this.resilience = new ResilienceController(options);
  }

  async rerank(request: RerankRequest): Promise<RerankResult[]> {
    const scope = await this.resilience.open({
      operation: 'rerank',
      model: request.model,
      signal: request.signal,
      inputCharacters:
        request.query.length + request.documents.reduce((sum, item) => sum + item.text.length, 0),
    });
    try {
      const response = await scope.retry(async () => {
        const nextResponse = await (this.options.fetcher ?? fetch)(this.options.url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: request.model,
            query: request.query,
            documents: request.documents.map((document) => document.text),
            top_n: request.topN,
          }),
          signal: combineAbortSignals(
            request.signal,
            AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
          ),
        });
        if (!nextResponse.ok) {
          const details = (await nextResponse.text()).slice(0, 1_000);
          throw new ModelHttpError(
            nextResponse.status,
            `Reranker returned ${nextResponse.status}: ${details}`,
          );
        }
        return nextResponse;
      });
      const payload = (await response.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };
      const results = (payload.results ?? []).map((result) => {
        const document = request.documents[result.index];
        if (!document) throw new Error(`Reranker returned invalid document index ${result.index}`);
        return { id: document.id, score: result.relevance_score };
      });
      await scope.succeed();
      return results;
    } catch (error) {
      await scope.fail(error);
      throw error;
    }
  }
}

type EmbeddingGatewayFactoryOptions = {
  provider: 'local' | 'openai-compatible';
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
  timeoutMs?: number;
  includeUsage?: boolean;
} & ModelResilienceOptions;

export function createEmbeddingGateway(
  options: EmbeddingGatewayFactoryOptions,
): Pick<ModelGateway, 'embed'> {
  if (options.provider === 'local') return new LocalHashEmbeddingGateway(options.onMetric);
  if (!options.baseUrl || !options.apiKey)
    throw new Error('OpenAI-compatible model gateway requires baseUrl and apiKey');
  return new OpenAICompatibleModelGateway({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    dimensions: options.dimensions,
    timeoutMs: options.timeoutMs,
    maxConcurrency: options.maxConcurrency,
    maxQueueSize: options.maxQueueSize,
    requestsPerMinute: options.requestsPerMinute,
    rateLimiter: options.rateLimiter,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    circuitBreaker: options.circuitBreaker,
    circuitFailureThreshold: options.circuitFailureThreshold,
    circuitResetMs: options.circuitResetMs,
    circuitHalfOpenMaxRequests: options.circuitHalfOpenMaxRequests,
    circuitHalfOpenSuccessThreshold: options.circuitHalfOpenSuccessThreshold,
    circuitHalfOpenProbeTimeoutMs: options.circuitHalfOpenProbeTimeoutMs,
    includeUsage: options.includeUsage,
    onMetric: options.onMetric,
  });
}

export function createRerankGateway(
  options: {
    provider: 'local' | 'http';
    url?: string;
    apiKey?: string;
    timeoutMs?: number;
  } & ModelResilienceOptions,
): RerankGateway {
  if (options.provider === 'local') return new LocalLexicalRerankGateway(options.onMetric);
  if (!options.url || !options.apiKey) throw new Error('HTTP reranker requires url and apiKey');
  return new HttpRerankGateway({
    url: options.url,
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
    maxConcurrency: options.maxConcurrency,
    maxQueueSize: options.maxQueueSize,
    requestsPerMinute: options.requestsPerMinute,
    rateLimiter: options.rateLimiter,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    circuitBreaker: options.circuitBreaker,
    circuitFailureThreshold: options.circuitFailureThreshold,
    circuitResetMs: options.circuitResetMs,
    circuitHalfOpenMaxRequests: options.circuitHalfOpenMaxRequests,
    circuitHalfOpenSuccessThreshold: options.circuitHalfOpenSuccessThreshold,
    circuitHalfOpenProbeTimeoutMs: options.circuitHalfOpenProbeTimeoutMs,
    onMetric: options.onMetric,
  });
}

export function createChatGateway(
  options: EmbeddingGatewayFactoryOptions,
): Pick<ModelGateway, 'streamChat'> | null {
  if (options.provider === 'local') return null;
  if (!options.baseUrl || !options.apiKey)
    throw new Error('OpenAI-compatible chat gateway requires baseUrl and apiKey');
  return new OpenAICompatibleModelGateway({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    dimensions: options.dimensions,
    timeoutMs: options.timeoutMs,
    maxConcurrency: options.maxConcurrency,
    maxQueueSize: options.maxQueueSize,
    requestsPerMinute: options.requestsPerMinute,
    rateLimiter: options.rateLimiter,
    maxRetries: options.maxRetries,
    retryBaseDelayMs: options.retryBaseDelayMs,
    circuitBreaker: options.circuitBreaker,
    circuitFailureThreshold: options.circuitFailureThreshold,
    circuitResetMs: options.circuitResetMs,
    circuitHalfOpenMaxRequests: options.circuitHalfOpenMaxRequests,
    circuitHalfOpenSuccessThreshold: options.circuitHalfOpenSuccessThreshold,
    circuitHalfOpenProbeTimeoutMs: options.circuitHalfOpenProbeTimeoutMs,
    includeUsage: options.includeUsage,
    onMetric: options.onMetric,
  });
}

function parseChatEvent(event: string): {
  done: boolean;
  token: string;
  usage?: ModelTokenUsage;
} {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return { done: false, token: '' };
  if (data === '[DONE]') return { done: true, token: '' };
  const payload = JSON.parse(data) as {
    choices?: Array<{ delta?: { content?: string | null } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  return {
    done: false,
    token: payload.choices?.[0]?.delta?.content ?? '',
    usage: normalizeUsage(payload.usage),
  };
}

export class ModelGatewayUnavailableError extends Error {
  constructor(
    readonly circuitState: 'open' | 'half-open' = 'open',
    readonly retryAfterMs?: number,
  ) {
    super('Model gateway circuit is open');
    this.name = 'ModelGatewayUnavailableError';
  }
}

export class ModelGatewayOverloadedError extends Error {
  constructor() {
    super('Model gateway concurrency queue is full');
    this.name = 'ModelGatewayOverloadedError';
  }
}

export class ModelGatewayRateLimitError extends Error {
  constructor(readonly retryAfterMs?: number) {
    super('Model gateway request rate limit exceeded');
    this.name = 'ModelGatewayRateLimitError';
  }
}

class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelHttpError';
  }
}

type CallContext = {
  operation: ModelOperation;
  model: string;
  signal?: AbortSignal;
  inputCharacters: number;
};

class ResilienceController {
  private readonly gate: ConcurrencyGate;
  private readonly rateLimiter: ModelRateLimiter;
  private readonly circuitBreaker: ModelCircuitBreaker;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitResetMs: number;
  private readonly circuitHalfOpenMaxRequests: number;
  private readonly circuitHalfOpenSuccessThreshold: number;
  private readonly circuitHalfOpenProbeTimeoutMs: number;

  constructor(private readonly options: ModelResilienceOptions) {
    this.gate = new ConcurrencyGate(
      Math.max(1, Math.floor(options.maxConcurrency ?? 8)),
      Math.max(0, Math.floor(options.maxQueueSize ?? 100)),
    );
    this.rateLimiter = options.rateLimiter ?? new FixedWindowRateLimiter();
    this.circuitBreaker = options.circuitBreaker ?? new LocalModelCircuitBreaker();
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
    this.circuitFailureThreshold = Math.max(1, Math.floor(options.circuitFailureThreshold ?? 5));
    this.circuitResetMs = Math.max(0, options.circuitResetMs ?? 30_000);
    this.circuitHalfOpenMaxRequests = Math.max(
      1,
      Math.floor(options.circuitHalfOpenMaxRequests ?? 1),
    );
    this.circuitHalfOpenSuccessThreshold = Math.max(
      1,
      Math.floor(options.circuitHalfOpenSuccessThreshold ?? 2),
    );
    this.circuitHalfOpenProbeTimeoutMs = Math.max(
      1,
      Math.floor(options.circuitHalfOpenProbeTimeoutMs ?? 90_000),
    );
  }

  async open(context: CallContext): Promise<ModelCallScope> {
    const startedAt = Date.now();
    if (context.signal?.aborted) {
      this.emit(context, 'cancelled', startedAt, 0, 0);
      throw abortError(context.signal.reason);
    }
    const circuitInput = this.circuitInput(context);
    let circuitDecision;
    try {
      circuitDecision = await this.circuitBreaker.acquire(circuitInput);
    } catch (error) {
      this.emit(context, 'rejected', startedAt, 0, 0);
      throw error;
    }
    if (!circuitDecision.allowed) {
      this.emit(context, 'rejected', startedAt, 0, 0);
      throw new ModelGatewayUnavailableError(circuitDecision.state, circuitDecision.retryAfterMs);
    }
    try {
      const decision = await this.rateLimiter.consume({
        operation: context.operation,
        model: context.model,
        limit: Math.max(0, Math.floor(this.options.requestsPerMinute ?? 600)),
      });
      if (!decision.allowed) throw new ModelGatewayRateLimitError(decision.retryAfterMs);
      const release = await this.gate.acquire(context.signal);
      return new ModelCallScope(
        this,
        context,
        release,
        startedAt,
        circuitInput,
        circuitDecision.permit,
      );
    } catch (error) {
      await this.releaseCircuit(circuitInput, circuitDecision.permit);
      this.emit(context, isAbortError(error) ? 'cancelled' : 'rejected', startedAt, 0, 0);
      throw error;
    }
  }

  async callSucceeded(
    context: CallContext,
    release: () => void,
    startedAt: number,
    attempts: number,
    circuitInput: ModelCircuitBreakerInput,
    circuitPermit: ModelCircuitPermit,
    usage?: ModelTokenUsage,
    outputCharacters = 0,
    firstTokenDurationMs?: number,
  ): Promise<void> {
    release();
    await this.reportCircuit(() => this.circuitBreaker.succeed(circuitInput, circuitPermit));
    this.emit(
      context,
      'success',
      startedAt,
      attempts,
      outputCharacters,
      usage,
      firstTokenDurationMs,
    );
  }

  async callFailed(
    context: CallContext,
    release: () => void,
    startedAt: number,
    attempts: number,
    circuitInput: ModelCircuitBreakerInput,
    circuitPermit: ModelCircuitPermit,
    error: unknown,
    outputCharacters = 0,
    firstTokenDurationMs?: number,
  ): Promise<void> {
    release();
    if (isRetryableError(error) && !context.signal?.aborted) {
      await this.reportCircuit(() => this.circuitBreaker.fail(circuitInput, circuitPermit));
    } else {
      await this.releaseCircuit(circuitInput, circuitPermit);
    }
    this.emit(
      context,
      context.signal?.aborted || isAbortError(error) ? 'cancelled' : 'error',
      startedAt,
      attempts,
      outputCharacters,
      undefined,
      firstTokenDurationMs,
    );
  }

  retrySettings(circuitPermit: ModelCircuitPermit): {
    maxRetries: number;
    retryBaseDelayMs: number;
  } {
    return {
      maxRetries: circuitPermit.state === 'half-open' ? 0 : this.maxRetries,
      retryBaseDelayMs: this.retryBaseDelayMs,
    };
  }

  private circuitInput(context: CallContext): ModelCircuitBreakerInput {
    return {
      operation: context.operation,
      model: context.model,
      failureThreshold: this.circuitFailureThreshold,
      resetMs: this.circuitResetMs,
      halfOpenMaxRequests: this.circuitHalfOpenMaxRequests,
      halfOpenSuccessThreshold: this.circuitHalfOpenSuccessThreshold,
      halfOpenProbeTimeoutMs: this.circuitHalfOpenProbeTimeoutMs,
    };
  }

  private async releaseCircuit(
    input: ModelCircuitBreakerInput,
    permit: ModelCircuitPermit,
  ): Promise<void> {
    await this.reportCircuit(() => this.circuitBreaker.release(input, permit));
  }

  private async reportCircuit(report: () => Promise<void>): Promise<void> {
    try {
      await report();
    } catch {
      // Circuit reporting must not change an already completed model call.
    }
  }

  private emit(
    context: CallContext,
    status: ModelCallMetric['status'],
    startedAt: number,
    attempts: number,
    outputCharacters: number,
    usage?: ModelTokenUsage,
    firstTokenDurationMs?: number,
  ): void {
    emitMetric(this.options.onMetric, {
      operation: context.operation,
      model: context.model,
      status,
      durationMs: Date.now() - startedAt,
      firstTokenDurationMs,
      attempts,
      inputCharacters: context.inputCharacters,
      outputCharacters,
      usage,
    });
  }
}

class ModelCallScope {
  private attempts = 0;
  private closed = false;
  private firstTokenDurationMs: number | undefined;

  constructor(
    private readonly controller: ResilienceController,
    private readonly context: CallContext,
    private readonly release: () => void,
    private readonly startedAt: number,
    private readonly circuitInput: ModelCircuitBreakerInput,
    private readonly circuitPermit: ModelCircuitPermit,
  ) {}

  async retry<T>(operation: () => Promise<T>): Promise<T> {
    const { maxRetries, retryBaseDelayMs } = this.controller.retrySettings(this.circuitPermit);
    while (true) {
      if (this.context.signal?.aborted) throw abortError(this.context.signal.reason);
      this.attempts += 1;
      try {
        return await operation();
      } catch (error) {
        if (
          this.context.signal?.aborted ||
          !isRetryableError(error) ||
          this.attempts > maxRetries
        ) {
          throw error;
        }
        await abortableDelay(retryBaseDelayMs * 2 ** (this.attempts - 1), this.context.signal);
      }
    }
  }

  async succeed(usage?: ModelTokenUsage, outputCharacters = 0): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.controller.callSucceeded(
      this.context,
      this.release,
      this.startedAt,
      this.attempts,
      this.circuitInput,
      this.circuitPermit,
      usage,
      outputCharacters,
      this.firstTokenDurationMs,
    );
  }

  async fail(error: unknown, outputCharacters = 0): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.controller.callFailed(
      this.context,
      this.release,
      this.startedAt,
      this.attempts,
      this.circuitInput,
      this.circuitPermit,
      error,
      outputCharacters,
      this.firstTokenDurationMs,
    );
  }

  isClosed(): boolean {
    return this.closed;
  }

  markFirstToken(): void {
    this.firstTokenDurationMs ??= Date.now() - this.startedAt;
  }
}

class FixedWindowRateLimiter {
  private windowStartedAt = Date.now();
  private requests = 0;

  async consume(input: ModelRateLimitInput, now = Date.now()): Promise<ModelRateLimitDecision> {
    if (input.limit === 0) return { allowed: true };
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.requests = 0;
    }
    if (this.requests >= input.limit) {
      return { allowed: false, retryAfterMs: Math.max(1, 60_000 - (now - this.windowStartedAt)) };
    }
    this.requests += 1;
    return { allowed: true };
  }
}

export { RedisModelRateLimiter, type RedisModelRateLimiterOptions } from './redis-rate-limiter.js';
export {
  RedisModelCircuitBreaker,
  type RedisModelCircuitBreakerOptions,
} from './redis-circuit-breaker.js';

class ConcurrencyGate {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueueSize: number,
  ) {}

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(this.releaseFunction());
    }
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new ModelGatewayOverloadedError());
    }
    return new Promise((resolve, reject) => {
      const item: (typeof this.queue)[number] = { resolve, reject, signal };
      if (signal) {
        item.onAbort = () => {
          const index = this.queue.indexOf(item);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(signal.reason));
        };
        signal.addEventListener('abort', item.onAbort, { once: true });
      }
      this.queue.push(item);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.activateNext();
    };
  }

  private activateNext(): void {
    while (this.queue.length > 0 && this.active < this.maxConcurrency) {
      const next = this.queue.shift();
      if (!next) return;
      if (next.onAbort && next.signal) next.signal.removeEventListener('abort', next.onAbort);
      if (next.signal?.aborted) {
        next.reject(abortError(next.signal.reason));
        continue;
      }
      this.active += 1;
      next.resolve(this.releaseFunction());
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ModelHttpError) {
    return [408, 429, 500, 502, 503, 504].includes(error.status);
  }
  return error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

function combineAbortSignals(
  callerSignal: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal?.reason));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeUsage(
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined,
): ModelTokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

function emitMetric(observer: ModelCallObserver | undefined, metric: ModelCallMetric): void {
  try {
    observer?.(metric);
  } catch {
    // Metrics must not change model-call behavior.
  }
}

function embedText(input: string): number[] {
  const vector = Array<number>(LOCAL_HASH_EMBEDDING_DIMENSIONS).fill(0);
  const frequencies = new Map<string, number>();
  for (const token of tokenize(input.normalize('NFKC').toLowerCase())) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  for (const [token, frequency] of frequencies) {
    const digest = simpleTokenHash(token);
    const index = (((digest[0] ?? 0) << 8) | (digest[1] ?? 0)) % LOCAL_HASH_EMBEDDING_DIMENSIONS;
    const sign = ((digest[2] ?? 0) & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(frequency));
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

function tokenize(input: string): string[] {
  const result: string[] = [];
  for (const match of input
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{Script=Han}]+|[\p{Letter}\p{Number}]+/gu)) {
    const segment = match[0];
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const characters = [...segment];
      result.push(...characters);
      for (let index = 0; index < characters.length - 1; index += 1) {
        result.push(`${characters[index]}${characters[index + 1]}`);
      }
    } else {
      result.push(segment);
    }
  }
  return result;
}

function tokenWeight(token: string): number {
  return [...token].length === 1 ? 0.25 : 1;
}

function simpleTokenHash(token: string): Uint8Array {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of token) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return new Uint8Array([first >>> 24, first >>> 16, second >>> 24, second >>> 16]);
}
