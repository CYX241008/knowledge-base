import { randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import type {
  AnswerCitation,
  AnswerFeedbackReason,
  AuditEventListResponse,
  AuditEventQuery,
  EvaluationCandidateQuery,
  QualityCostResponse,
  RagEvaluationCandidateListResponse,
  SearchPreferencesResponse,
  SubmitSearchFeedbackRequest,
  SubmitSearchFeedbackResponse,
  SystemRetrievalSettings,
  SystemSettingsResponse,
  UpdateSystemSettingsRequest,
} from '@knowledge-base/contracts';
import {
  AppUserEntity,
  AuditEventEntity,
  ChatCitationEntity,
  SearchFeedbackEntity,
  SearchQueryEventEntity,
  TenantSystemSettingEntity,
} from '@knowledge-base/database';
import { DataSource, In } from 'typeorm';
import { parseModelPricingCatalog } from '@knowledge-base/model-gateway';
import { AccessControlService } from '../access-control/access-control.service';
import type { AuthContext } from '../auth/auth-context';
import { ModelMetricsService } from '../observability/model-metrics.service';
import { ModelBudgetService } from '../observability/model-budget.service';

const defaultRetrievalSettings: SystemRetrievalSettings = {
  candidateLimit: 200,
  scoreThreshold: 0,
  defaultPageSize: 10,
  feedbackEnabled: true,
};
const defaultGovernanceSettings = {
  auditRetentionDays: 365,
  modelDailyBudgetUsd: 0,
  modelMonthlyBudgetUsd: 0,
  modelBudgetAction: 'warn' as const,
};

type EffectiveSettings = SystemRetrievalSettings & {
  auditRetentionDays: number;
  modelDailyBudgetUsd: number;
  modelMonthlyBudgetUsd: number;
  modelBudgetAction: 'warn' | 'degrade' | 'reject';
};

@Injectable()
export class SystemGovernanceService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
    @Inject(ModelMetricsService) private readonly modelMetrics: ModelMetricsService,
    @Inject(ModelBudgetService) private readonly modelBudget: ModelBudgetService,
  ) {}

  async effectiveSettings(tenantId: string): Promise<EffectiveSettings> {
    const entity = await this.dataSource
      .getRepository(TenantSystemSettingEntity)
      .findOneBy({ tenantId });
    return entity
      ? {
          candidateLimit: entity.searchCandidateLimit,
          scoreThreshold: entity.searchScoreThreshold,
          defaultPageSize: entity.searchPageSize,
          feedbackEnabled: entity.feedbackEnabled,
          auditRetentionDays: entity.auditRetentionDays,
          modelDailyBudgetUsd: entity.modelDailyBudgetUsd,
          modelMonthlyBudgetUsd: entity.modelMonthlyBudgetUsd,
          modelBudgetAction: entity.modelBudgetAction,
        }
      : {
          ...defaultRetrievalSettings,
          ...defaultGovernanceSettings,
        };
  }

  async preferences(tenantId: string): Promise<SearchPreferencesResponse> {
    const settings = await this.effectiveSettings(tenantId);
    return { pageSize: settings.defaultPageSize, feedbackEnabled: settings.feedbackEnabled };
  }

  async settings(auth: AuthContext): Promise<SystemSettingsResponse> {
    this.accessControl.assertGovernanceRead(auth);
    const entity = await this.dataSource
      .getRepository(TenantSystemSettingEntity)
      .findOneBy({ tenantId: auth.tenantId });
    const effective = await this.effectiveSettings(auth.tenantId);
    return {
      tenantId: auth.tenantId,
      version: entity?.version ?? 1,
      retrieval: {
        candidateLimit: effective.candidateLimit,
        scoreThreshold: effective.scoreThreshold,
        defaultPageSize: effective.defaultPageSize,
        feedbackEnabled: effective.feedbackEnabled,
      },
      governance: {
        auditRetentionDays: effective.auditRetentionDays,
        modelDailyBudgetUsd: effective.modelDailyBudgetUsd,
        modelMonthlyBudgetUsd: effective.modelMonthlyBudgetUsd,
        modelBudgetAction: effective.modelBudgetAction,
      },
      runtime: {
        modelProvider: this.config.getOrThrow('MODEL_PROVIDER'),
        embeddingModel: this.config.getOrThrow('EMBEDDING_MODEL'),
        chatModel: this.config.getOrThrow('CHAT_MODEL'),
        rerankerProvider: this.config.getOrThrow('RERANKER_PROVIDER'),
        rerankerModel: this.config.getOrThrow('RERANKER_MODEL'),
        mmrLambda: this.config.getOrThrow('RAG_MMR_LAMBDA'),
        nearDuplicateThreshold: this.config.getOrThrow('RAG_NEAR_DUPLICATE_THRESHOLD'),
        queryPlanningEnabled: this.config.getOrThrow('RAG_QUERY_PLANNING_ENABLED'),
        modelRequestTimeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
        modelRequestsPerMinute: this.config.getOrThrow('MODEL_REQUESTS_PER_MINUTE'),
        modelGlobalTokensPerMinute: this.config.getOrThrow('MODEL_GLOBAL_TOKENS_PER_MINUTE'),
        modelTenantTokensPerMinute: this.config.getOrThrow('MODEL_TENANT_TOKENS_PER_MINUTE'),
        modelUserTokensPerMinute: this.config.getOrThrow('MODEL_USER_TOKENS_PER_MINUTE'),
        embeddingTokensPerMinute: this.config.getOrThrow('MODEL_EMBEDDING_TOKENS_PER_MINUTE'),
        chatTokensPerMinute: this.config.getOrThrow('MODEL_CHAT_TOKENS_PER_MINUTE'),
        rerankTokensPerMinute: this.config.getOrThrow('MODEL_RERANK_TOKENS_PER_MINUTE'),
        tokenizerEncoding: this.config.getOrThrow('MODEL_TOKENIZER_ENCODING'),
        chatMaxOutputTokens: this.config.getOrThrow('CHAT_MAX_OUTPUT_TOKENS'),
        chatContextWindowTokens: this.config.getOrThrow('CHAT_CONTEXT_WINDOW_TOKENS'),
        ragMaxContextTokens: this.config.getOrThrow('RAG_MAX_CONTEXT_TOKENS'),
        ragContextSafetyTokens: this.config.getOrThrow('RAG_CONTEXT_SAFETY_TOKENS'),
        rerankCandidateLimit: this.config.getOrThrow('RAG_RERANK_CANDIDATE_LIMIT'),
        rerankMaxTokens: this.config.getOrThrow('RAG_RERANK_MAX_TOKENS'),
        maxChunksPerDocument: this.config.getOrThrow('RAG_MAX_CHUNKS_PER_DOCUMENT'),
        embeddingBatchMaxInputs: this.config.getOrThrow('EMBEDDING_BATCH_MAX_INPUTS'),
        embeddingBatchMaxTokens: this.config.getOrThrow('EMBEDDING_BATCH_MAX_TOKENS'),
        documentMaxChunks: this.config.getOrThrow('DOCUMENT_MAX_CHUNKS'),
        modelMaxCallCostUsd: this.config.getOrThrow('MODEL_MAX_CALL_COST_USD'),
        modelPricingRuleCount: Object.keys(
          parseModelPricingCatalog(this.config.getOrThrow('MODEL_PRICING_JSON')),
        ).length,
        modelBudgetTimezoneOffsetMinutes: this.config.getOrThrow(
          'MODEL_BUDGET_TIMEZONE_OFFSET_MINUTES',
        ),
        modelInteractiveMaxConcurrency: this.config.getOrThrow('MODEL_INTERACTIVE_MAX_CONCURRENCY'),
        modelInteractiveMaxQueueSize: this.config.getOrThrow('MODEL_INTERACTIVE_MAX_QUEUE_SIZE'),
        modelBatchMaxConcurrency: this.config.getOrThrow('MODEL_BATCH_MAX_CONCURRENCY'),
        modelBatchMaxQueueSize: this.config.getOrThrow('MODEL_BATCH_MAX_QUEUE_SIZE'),
        chatFallbackModel: this.config.get('CHAT_FALLBACK_MODEL') ?? null,
        chatDegradedMaxOutputTokens: this.config.getOrThrow('CHAT_DEGRADED_MAX_OUTPUT_TOKENS'),
        chatHistoryMaxTokens: this.config.getOrThrow('CHAT_HISTORY_MAX_TOKENS'),
        chatHistoryMaxMessages: this.config.getOrThrow('CHAT_HISTORY_MAX_MESSAGES'),
        ragDegradedContextTokens: this.config.getOrThrow('RAG_DEGRADED_CONTEXT_TOKENS'),
        ragMinRelevance: this.config.getOrThrow('RAG_MIN_RELEVANCE'),
        maxUploadSizeBytes: this.config.getOrThrow('MAX_UPLOAD_SIZE_BYTES'),
        chatRetentionDays: this.config.getOrThrow('CHAT_RETENTION_DAYS'),
        elasticsearchIndex: this.config.getOrThrow('ELASTICSEARCH_INDEX'),
      },
      canEdit: this.accessControl.canEditSystemSettings(auth),
      updatedBy: entity?.updatedBy ?? null,
      updatedAt: entity?.updatedAt.toISOString() ?? null,
    };
  }

  async updateSettings(
    auth: AuthContext,
    input: UpdateSystemSettingsRequest,
  ): Promise<SystemSettingsResponse> {
    this.accessControl.assertSystemAdministration(auth);
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(TenantSystemSettingEntity);
      const existing = await repository.findOne({
        where: { tenantId: auth.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      const before = existing
        ? serializeSettings(existing)
        : { ...defaultRetrievalSettings, ...defaultGovernanceSettings };
      const entity = repository.create({
        ...existing,
        tenantId: auth.tenantId,
        searchCandidateLimit: input.retrieval.candidateLimit,
        searchScoreThreshold: input.retrieval.scoreThreshold,
        searchPageSize: input.retrieval.defaultPageSize,
        feedbackEnabled: input.retrieval.feedbackEnabled,
        auditRetentionDays: input.governance.auditRetentionDays,
        modelDailyBudgetUsd: input.governance.modelDailyBudgetUsd,
        modelMonthlyBudgetUsd: input.governance.modelMonthlyBudgetUsd,
        modelBudgetAction: input.governance.modelBudgetAction,
        version: (existing?.version ?? 1) + 1,
        updatedBy: auth.userId,
      });
      await repository.save(entity);
      await this.accessControl.recordAudit(
        manager,
        auth,
        'system.settings.updated',
        'tenant',
        auth.tenantId,
        { before, after: serializeSettings(entity), version: entity.version },
      );
      await manager
        .getRepository(AuditEventEntity)
        .createQueryBuilder()
        .delete()
        .where('tenant_id = :tenantId', { tenantId: auth.tenantId })
        .andWhere('created_at < now() - make_interval(days => :retentionDays)', {
          retentionDays: input.governance.auditRetentionDays,
        })
        .execute();
    });
    return this.settings(auth);
  }

  async audit(auth: AuthContext, query: AuditEventQuery): Promise<AuditEventListResponse> {
    this.accessControl.assertSystemAdministration(auth);
    const settings = await this.effectiveSettings(auth.tenantId);
    await this.pruneAudit(auth.tenantId, settings.auditRetentionDays);
    const [items, total] = await this.dataSource.getRepository(AuditEventEntity).findAndCount({
      where: {
        tenantId: auth.tenantId,
        ...(query.action ? { action: query.action } : {}),
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
      },
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    const actorIds = [...new Set(items.flatMap((item) => item.actorId ?? []))];
    const actors = actorIds.length
      ? await this.dataSource
          .getRepository(AppUserEntity)
          .findBy({ tenantId: auth.tenantId, id: In(actorIds) })
      : [];
    const actorNames = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    return {
      items: items.map((item) => ({
        id: item.id,
        actorId: item.actorId,
        actorName: item.actorId ? (actorNames.get(item.actorId) ?? null) : null,
        action: item.action,
        resourceType: item.resourceType,
        resourceId: item.resourceId,
        metadata: item.metadata,
        createdAt: item.createdAt.toISOString(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async quality(auth: AuthContext, days: number): Promise<QualityCostResponse> {
    this.accessControl.assertGovernanceRead(auth);
    const [searchRows, feedbackRows, reasonRows, answerFeedbackRows, answerReasonRows] =
      await Promise.all([
        this.dataSource.query<
          Array<{
            totalQueries: string;
            zeroResultQueries: string;
            averageDurationMs: string | null;
            averageResultCount: string | null;
          }>
        >(
          `SELECT COUNT(*) AS "totalQueries",
                COUNT(*) FILTER (WHERE status = 'success' AND result_count = 0) AS "zeroResultQueries",
                AVG(duration_ms) AS "averageDurationMs",
                AVG(result_count) FILTER (WHERE status = 'success') AS "averageResultCount"
         FROM search_query_event
         WHERE tenant_id = $1 AND created_at >= now() - make_interval(days => $2)`,
          [auth.tenantId, days],
        ),
        this.dataSource.query<Array<{ total: string; helpful: string; unhelpful: string }>>(
          `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE rating = 'helpful') AS helpful,
                COUNT(*) FILTER (WHERE rating = 'unhelpful') AS unhelpful
         FROM search_feedback
         WHERE tenant_id = $1 AND created_at >= now() - make_interval(days => $2)`,
          [auth.tenantId, days],
        ),
        this.dataSource.query<
          Array<{ reason: SubmitSearchFeedbackRequest['reason']; count: number }>
        >(
          `SELECT reason, COUNT(*)::int AS count
         FROM search_feedback
         WHERE tenant_id = $1
           AND rating = 'unhelpful'
           AND created_at >= now() - make_interval(days => $2)
         GROUP BY reason ORDER BY count DESC`,
          [auth.tenantId, days],
        ),
        this.dataSource.query<Array<{ total: string; helpful: string; unhelpful: string }>>(
          `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE rating = 'helpful') AS helpful,
                COUNT(*) FILTER (WHERE rating = 'unhelpful') AS unhelpful
         FROM answer_feedback
         WHERE tenant_id = $1 AND created_at >= now() - make_interval(days => $2)`,
          [auth.tenantId, days],
        ),
        this.dataSource.query<Array<{ reason: AnswerFeedbackReason | null; count: number }>>(
          `SELECT reason, COUNT(*)::int AS count
         FROM answer_feedback
         WHERE tenant_id = $1
           AND rating = 'unhelpful'
           AND created_at >= now() - make_interval(days => $2)
         GROUP BY reason ORDER BY count DESC`,
          [auth.tenantId, days],
        ),
      ]);
    const search = searchRows[0];
    const feedback = feedbackRows[0];
    const answerFeedback = answerFeedbackRows[0];
    const totalQueries = Number(search?.totalQueries ?? 0);
    const zeroResultQueries = Number(search?.zeroResultQueries ?? 0);
    const feedbackTotal = Number(feedback?.total ?? 0);
    const helpful = Number(feedback?.helpful ?? 0);
    const answerFeedbackTotal = Number(answerFeedback?.total ?? 0);
    const helpfulAnswers = Number(answerFeedback?.helpful ?? 0);
    const modelSnapshot = await this.modelMetrics.usageForTenant(auth.tenantId, days);
    const budget = await this.modelBudget.status(auth.tenantId);
    const operations = modelSnapshot.operations.map((operation) => ({
      operation: operation.operation,
      model: operation.model,
      calls: operation.calls,
      success: operation.success,
      errors: operation.errors,
      averageDurationMs: operation.averageDurationMs,
      averageFirstTokenDurationMs: operation.averageFirstTokenDurationMs,
      inputTokens: operation.inputTokens,
      outputTokens: operation.outputTokens,
      estimatedCostUsd: operation.estimatedCostUsd,
    }));
    return {
      windowDays: days,
      search: {
        totalQueries,
        zeroResultRate: totalQueries ? round(zeroResultQueries / totalQueries, 4) : 0,
        averageDurationMs: round(Number(search?.averageDurationMs ?? 0), 2),
        averageResultCount: round(Number(search?.averageResultCount ?? 0), 2),
      },
      feedback: {
        total: feedbackTotal,
        helpful,
        unhelpful: Number(feedback?.unhelpful ?? 0),
        helpfulRate: feedbackTotal ? round(helpful / feedbackTotal, 4) : 0,
        reasons: reasonRows.map((item) => ({
          reason: item.reason ?? null,
          count: Number(item.count),
        })),
      },
      answerFeedback: {
        total: answerFeedbackTotal,
        helpful: helpfulAnswers,
        unhelpful: Number(answerFeedback?.unhelpful ?? 0),
        helpfulRate: answerFeedbackTotal ? round(helpfulAnswers / answerFeedbackTotal, 4) : 0,
        reasons: answerReasonRows.map((item) => ({
          reason: item.reason ?? null,
          count: Number(item.count),
        })),
      },
      models: {
        startedAt: modelSnapshot.startedAt,
        totalCalls: operations.reduce((sum, item) => sum + item.calls, 0),
        totalTokens: operations.reduce(
          (sum, item) => sum + item.inputTokens + item.outputTokens,
          0,
        ),
        estimatedCostUsd: round(
          operations.reduce((sum, item) => sum + item.estimatedCostUsd, 0),
          6,
        ),
        budget: {
          action: budget.assessment.action,
          daily: {
            usedUsd: budget.assessment.daily.usedUsd,
            budgetUsd: budget.assessment.daily.budgetUsd,
            ratio: budget.assessment.daily.ratio,
          },
          monthly: {
            usedUsd: budget.assessment.monthly.usedUsd,
            budgetUsd: budget.assessment.monthly.budgetUsd,
            ratio: budget.assessment.monthly.ratio,
          },
          alerts: budget.alerts.map((alert) => ({
            id: alert.id,
            periodType: alert.periodType,
            thresholdPercent: alert.thresholdPercent,
            usageCostUsd: alert.usageCostUsd,
            budgetUsd: alert.budgetUsd,
            createdAt: alert.createdAt.toISOString(),
          })),
        },
        operations,
      },
    };
  }

  async evaluationCandidates(
    auth: AuthContext,
    query: EvaluationCandidateQuery,
  ): Promise<RagEvaluationCandidateListResponse> {
    this.accessControl.assertGovernanceRead(auth);
    const rows = await this.dataSource.query<
      Array<{
        feedbackId: string;
        runId: string;
        question: string;
        observedAnswer: string;
        model: string | null;
        degraded: boolean;
        degradationReason: string | null;
        reason: AnswerFeedbackReason | null;
        comment: string | null;
        assistantMessageId: string;
        createdAt: Date | string;
      }>
    >(
      `SELECT feedback.id AS "feedbackId",
              run.id AS "runId",
              question.content AS question,
              answer.content AS "observedAnswer",
              run.actual_model AS model,
              run.degraded,
              run.degradation_reason AS "degradationReason",
              feedback.reason,
              feedback.comment,
              run.assistant_message_id AS "assistantMessageId",
              feedback.updated_at AS "createdAt"
       FROM answer_feedback feedback
       INNER JOIN answer_run run
         ON run.id = feedback.answer_run_id
        AND run.tenant_id = feedback.tenant_id
       INNER JOIN chat_message question ON question.id = run.user_message_id
       INNER JOIN chat_message answer ON answer.id = run.assistant_message_id
       WHERE feedback.tenant_id = $1
         AND feedback.rating = 'unhelpful'
         AND feedback.updated_at >= now() - make_interval(days => $2)
       ORDER BY feedback.updated_at DESC, feedback.id DESC
       LIMIT $3`,
      [auth.tenantId, query.days, query.limit],
    );
    const citations =
      rows.length === 0
        ? []
        : await this.dataSource.getRepository(ChatCitationEntity).find({
            where: {
              tenantId: auth.tenantId,
              messageId: In(rows.map((row) => row.assistantMessageId)),
            },
            order: { messageId: 'ASC', ordinal: 'ASC' },
          });
    const citationsByMessage = new Map<string, typeof citations>();
    for (const citation of citations) {
      const items = citationsByMessage.get(citation.messageId) ?? [];
      items.push(citation);
      citationsByMessage.set(citation.messageId, items);
    }
    return {
      generatedAt: new Date().toISOString(),
      annotationRequired: true,
      items: rows.map((row) => {
        const answerCitations = citationsByMessage.get(row.assistantMessageId) ?? [];
        return {
          feedbackId: row.feedbackId,
          runId: row.runId,
          question: row.question,
          observedAnswer: row.observedAnswer,
          observedGrounded: answerCitations.length > 0,
          model: row.model,
          degraded: row.degraded,
          degradationReason: row.degradationReason,
          reason: row.reason,
          comment: row.comment,
          citations: answerCitations.map((citation) => ({
            ordinal: citation.ordinal,
            chunkId: citation.chunkId,
            documentId: citation.documentId,
            documentVersionId: citation.documentVersionId,
            title: citation.documentTitle,
            excerpt: citation.excerpt,
            source: citation.source as AnswerCitation['source'],
          })),
          createdAt:
            row.createdAt instanceof Date
              ? row.createdAt.toISOString()
              : new Date(row.createdAt).toISOString(),
        };
      }),
    };
  }

  async submitFeedback(
    auth: AuthContext,
    input: SubmitSearchFeedbackRequest,
  ): Promise<SubmitSearchFeedbackResponse> {
    const settings = await this.effectiveSettings(auth.tenantId);
    if (!settings.feedbackEnabled) {
      throw new ForbiddenException({
        code: 'SEARCH_FEEDBACK_DISABLED',
        message: 'Search feedback is disabled for this tenant',
      });
    }
    const queryEvent = await this.dataSource.getRepository(SearchQueryEventEntity).findOneBy({
      id: input.queryEventId,
      tenantId: auth.tenantId,
      userId: auth.userId,
    });
    if (!queryEvent) throw new NotFoundException(`Search query ${input.queryEventId} not found`);
    const repository = this.dataSource.getRepository(SearchFeedbackEntity);
    const existing = await repository.findOneBy({
      tenantId: auth.tenantId,
      queryEventId: input.queryEventId,
      userId: auth.userId,
    });
    const feedback = await repository.save(
      repository.create({
        ...existing,
        id: existing?.id ?? randomUUID(),
        tenantId: auth.tenantId,
        queryEventId: input.queryEventId,
        userId: auth.userId,
        rating: input.rating,
        reason: input.reason ?? null,
        comment: input.comment ?? null,
      }),
    );
    return {
      feedbackId: feedback.id,
      queryEventId: feedback.queryEventId,
      rating: feedback.rating,
    };
  }

  private async pruneAudit(tenantId: string, retentionDays: number): Promise<void> {
    await this.dataSource.query(
      'DELETE FROM audit_event WHERE tenant_id = $1 AND created_at < now() - make_interval(days => $2)',
      [tenantId, retentionDays],
    );
  }
}

function serializeSettings(entity: TenantSystemSettingEntity): EffectiveSettings {
  return {
    candidateLimit: entity.searchCandidateLimit,
    scoreThreshold: entity.searchScoreThreshold,
    defaultPageSize: entity.searchPageSize,
    feedbackEnabled: entity.feedbackEnabled,
    auditRetentionDays: entity.auditRetentionDays,
    modelDailyBudgetUsd: entity.modelDailyBudgetUsd,
    modelMonthlyBudgetUsd: entity.modelMonthlyBudgetUsd,
    modelBudgetAction: entity.modelBudgetAction,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
