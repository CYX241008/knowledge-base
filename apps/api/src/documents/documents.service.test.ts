import { BadRequestException } from '@nestjs/common';
import {
  DocumentEntity,
  DocumentReviewRequestEntity,
  DocumentVersionEntity,
} from '@knowledge-base/database';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/auth-context';
import { DocumentsService } from './documents.service';

const auth: AuthContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  principalIds: ['user:22222222-2222-4222-8222-222222222222'],
  permissionKeys: ['documents.review'],
  mode: 'demo',
};

describe('DocumentsService publication quality gate', () => {
  it('requires review before directly publishing a version with quality warnings', async () => {
    const document = {
      id: '33333333-3333-4333-8333-333333333333',
      tenantId: auth.tenantId,
      status: 'draft' as const,
      currentReadyVersionId: null,
      deletedAt: null,
    };
    const version = {
      id: '44444444-4444-4444-8444-444444444444',
      documentId: document.id,
      tenantId: auth.tenantId,
      versionNo: 1,
      ingestionStatus: 'ready' as const,
      qualityStatus: 'review' as const,
      qualityScore: 62,
      qualityReasons: ['OCR confidence is below the configured threshold'],
    };
    const manager = {
      getRepository: vi.fn((entity: unknown) => {
        if (entity === DocumentEntity) return { findOne: vi.fn(async () => document) };
        if (entity === DocumentVersionEntity) return { findOne: vi.fn(async () => version) };
        if (entity === DocumentReviewRequestEntity) return { findOne: vi.fn(async () => null) };
        throw new Error(`Missing fake repository for ${String(entity)}`);
      }),
    };
    const ingestion = {
      createSearchProjectionIntent: vi.fn(),
      dispatchPending: vi.fn(),
    };
    const service = new DocumentsService(
      { transaction: vi.fn(async (callback) => callback(manager)) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      ingestion as never,
      { recordAudit: vi.fn() } as never,
      {} as never,
    );

    await expectBadRequest(
      service.publishVersion(auth, document.id, version.id),
      'DOCUMENT_QUALITY_REVIEW_REQUIRED',
    );

    expect(document.currentReadyVersionId).toBeNull();
    expect(document.status).toBe('draft');
    expect(ingestion.createSearchProjectionIntent).not.toHaveBeenCalled();
    expect(ingestion.dispatchPending).not.toHaveBeenCalled();
  });
});

async function expectBadRequest(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected BadRequestException with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code });
  }
}
