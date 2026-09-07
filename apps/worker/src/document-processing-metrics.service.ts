import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { DocumentProcessingMetricEntity } from '@knowledge-base/database';
import type { DocumentProcessingObserver } from '@knowledge-base/rag';
import { logEvent } from '@knowledge-base/observability';

@Injectable()
export class DocumentProcessingMetricsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  readonly observe: DocumentProcessingObserver = async (metric, context) => {
    if (!context.tenantId || !context.documentVersionId) return;
    const repository = this.dataSource.getRepository(DocumentProcessingMetricEntity);
    try {
      await repository.save(
        repository.create({
          id: randomUUID(),
          tenantId: context.tenantId,
          documentVersionId: context.documentVersionId,
          pageNo: metric.location.type === 'page' ? metric.location.page : null,
          documentFormat: metric.format,
          locationType: metric.location.type,
          location: metric.location,
          operation: metric.operation,
          provider: metric.provider,
          model: metric.model ?? null,
          status: metric.status,
          durationMs: metric.durationMs,
          cacheHit: metric.cacheHit,
          assetId: metric.assetId ?? null,
          metadata: metric.metadata ?? {},
        }),
      );
    } catch (error) {
      logEvent('document.processing_metric_persist_failed', {
        tenantId: context.tenantId,
        documentVersionId: context.documentVersionId,
        format: metric.format,
        locationType: metric.location.type,
        operation: metric.operation,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
