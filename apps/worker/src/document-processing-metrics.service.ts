import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { DocumentProcessingMetricEntity } from '@knowledge-base/database';
import type { PdfProcessingObserver } from '@knowledge-base/rag';

@Injectable()
export class DocumentProcessingMetricsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  readonly observe: PdfProcessingObserver = async (metric, context) => {
    if (!context.tenantId || !context.documentVersionId) return;
    const repository = this.dataSource.getRepository(DocumentProcessingMetricEntity);
    await repository.save(
      repository.create({
        id: randomUUID(),
        tenantId: context.tenantId,
        documentVersionId: context.documentVersionId,
        pageNo: metric.page,
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
  };
}
