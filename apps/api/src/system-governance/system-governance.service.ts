import { randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import type {
  AuditEventListResponse,
  AuditEventQuery,
  QualityCostResponse,
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
  SearchFeedbackEntity,
  SearchQueryEventEntity,
  TenantSystemSettingEntity,
} from '@knowledge-base/database';
import { DataSource, In } from 'typeorm';
import { AccessControlService } from '../access-control/access-control.service';
import type { AuthContext } from '../auth/auth-context';
import { ModelMetricsService } from '../observability/model-metrics.service';

const defaultRetrievalSettings: SystemRetrievalSettings = {
  candidateLimit: 200,
  scoreThreshold: 0,
  defaultPageSize: 10,
  feedbackEnabled: true,
};

type EffectiveSettings = SystemRetrievalSettings & { auditRetentionDays: number };

@Injectable()
export class SystemGovernanceService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
    @Inject(ModelMetricsService) private readonly modelMetrics: ModelMetricsService,
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
        }
      : { ...defaultRetrievalSettings, auditRetentionDays: 365 };
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
      governance: { auditRetentionDays: effective.auditRetentionDays },
      runtime: {
        modelProvider: this.config.getOrThrow('MODEL_PROVIDER'),
        embeddingModel: this.config.getOrThrow('EMBEDDING_MODEL'),
        chatModel: this.config.getOrThrow('CHAT_MODEL'),
        rerankerProvider: this.config.getOrThrow('RERANKER_PROVIDER'),
        rerankerModel: this.config.getOrThrow('RERANKER_MODEL'),
        modelRequestTimeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
        modelRequestsPerMinute: this.config.getOrThrow('MODEL_REQUESTS_PER_MINUTE'),
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
        : { ...defaultRetrievalSettings, auditRetentionDays: 365 };
      const entity = repository.create({
        ...existing,
        tenantId: auth.tenantId,
        searchCandidateLimit: input.retrieval.candidateLimit,
        searchScoreThreshold: input.retrieval.scoreThreshold,
        searchPageSize: input.retrieval.defaultPageSize,
        feedbackEnabled: input.retrieval.feedbackEnabled,
        auditRetentionDays: input.governance.auditRetentionDays,
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
    const [searchRows, feedbackRows, reasonRows] = await Promise.all([
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
    ]);
    const search = searchRows[0];
    const feedback = feedbackRows[0];
    const totalQueries = Number(search?.totalQueries ?? 0);
    const zeroResultQueries = Number(search?.zeroResultQueries ?? 0);
    const feedbackTotal = Number(feedback?.total ?? 0);
    const helpful = Number(feedback?.helpful ?? 0);
    const modelSnapshot = this.modelMetrics.snapshot();
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
        operations,
      },
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
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
