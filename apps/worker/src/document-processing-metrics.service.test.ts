import type { DocumentProcessingMetricEntity } from '@knowledge-base/database';
import type { DocumentProcessingMetric } from '@knowledge-base/rag';
import type { DataSource, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { DocumentProcessingMetricsService } from './document-processing-metrics.service';

describe('DocumentProcessingMetricsService', () => {
  it('persists generic document locations and leaves page number nullable', async () => {
    const save = vi.fn(async () => undefined);
    const repository = {
      create: vi.fn((value: Partial<DocumentProcessingMetricEntity>) => value),
      save,
    } as unknown as Repository<DocumentProcessingMetricEntity>;
    const dataSource = {
      getRepository: vi.fn(() => repository),
    } as unknown as DataSource;
    const service = new DocumentProcessingMetricsService(dataSource);
    const metric: DocumentProcessingMetric = {
      operation: 'vision',
      format: 'docx',
      location: { type: 'section', heading: 'Architecture' },
      assetId: 'docx-f1',
      provider: 'openai-compatible',
      model: 'vision-model',
      status: 'success',
      durationMs: 125,
      cacheHit: false,
    };

    await service.observe(metric, {
      tenantId: '11111111-1111-4111-8111-111111111111',
      documentVersionId: '22222222-2222-4222-8222-222222222222',
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        pageNo: null,
        documentFormat: 'docx',
        locationType: 'section',
        location: { type: 'section', heading: 'Architecture' },
      }),
    );
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not fail document processing when metric persistence fails', async () => {
    const repository = {
      create: vi.fn((value: Partial<DocumentProcessingMetricEntity>) => value),
      save: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    } as unknown as Repository<DocumentProcessingMetricEntity>;
    const dataSource = {
      getRepository: vi.fn(() => repository),
    } as unknown as DataSource;
    const service = new DocumentProcessingMetricsService(dataSource);

    await expect(
      service.observe(
        {
          operation: 'ocr',
          format: 'pdf',
          location: { type: 'page', page: 3 },
          provider: 'tesseract',
          status: 'failed',
          durationMs: 20,
          cacheHit: false,
        },
        {
          tenantId: '11111111-1111-4111-8111-111111111111',
          documentVersionId: '22222222-2222-4222-8222-222222222222',
        },
      ),
    ).resolves.toBeUndefined();
  });
});
