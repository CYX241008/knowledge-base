import {
  AppUserEntity,
  DocumentEntity,
  DocumentReviewActionEntity,
  DocumentReviewRequestEntity,
  DocumentVersionEntity,
} from '@knowledge-base/database';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/auth-context';
import { DocumentReviewsService } from './document-reviews.service';

const auth: AuthContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  principalIds: [`user:22222222-2222-4222-8222-222222222222`],
  permissionKeys: ['documents.review'],
  mode: 'demo',
};
const oldVersionId = '33333333-3333-4333-8333-333333333333';
const nextVersionId = '44444444-4444-4444-8444-444444444444';
const documentId = '55555555-5555-4555-8555-555555555555';
const reviewId = '66666666-6666-4666-8666-666666666666';

describe('DocumentReviewsService', () => {
  it('submits a ready version without changing the current published version', async () => {
    const document = publishedDocument();
    const version = readyVersion();
    const reviewRepository = {
      findOne: vi.fn(async () => null),
      save: vi.fn(async (value) => value),
    };
    const manager = fakeManager(
      new Map<unknown, unknown>([
        [DocumentEntity, { findOne: vi.fn(async () => document) }],
        [DocumentVersionEntity, { findOne: vi.fn(async () => version) }],
        [DocumentReviewRequestEntity, reviewRepository],
        [DocumentReviewActionEntity, { save: vi.fn(async (value) => value) }],
      ]),
    );
    const ingestion = {
      createSearchProjectionIntent: vi.fn(),
      dispatchPending: vi.fn(),
    };
    const service = new DocumentReviewsService(
      { transaction: vi.fn(async (callback) => callback(manager)) } as never,
      {
        assertDocumentPermission: vi.fn(async () => document),
        recordAudit: vi.fn(async () => undefined),
      } as never,
      ingestion as never,
    );
    vi.spyOn(service as never, 'findReview' as never).mockResolvedValue({
      id: reviewId,
    } as never);

    await service.submit(auth, documentId, nextVersionId, 'Please review');

    expect(document.currentReadyVersionId).toBe(oldVersionId);
    expect(document.status).toBe('published');
    expect(ingestion.createSearchProjectionIntent).not.toHaveBeenCalled();
    expect(reviewRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        documentVersionId: nextVersionId,
        status: 'pending',
      }),
    );
  });

  it('atomically switches the published version only when a review is approved', async () => {
    const document = publishedDocument();
    const version = readyVersion();
    const review = {
      id: reviewId,
      tenantId: auth.tenantId,
      documentId,
      documentVersionId: nextVersionId,
      status: 'pending' as const,
      submittedBy: auth.userId,
      submittedAt: new Date(),
      resolvedBy: null,
      resolvedAt: null,
      decisionComment: null,
    };
    const manager = fakeManager(
      new Map<unknown, unknown>([
        [
          DocumentReviewRequestEntity,
          {
            findOne: vi.fn(async () => review),
            save: vi.fn(async (value) => value),
          },
        ],
        [DocumentVersionEntity, { findOne: vi.fn(async () => version) }],
        [DocumentEntity, { findOne: vi.fn(async () => document), save: vi.fn() }],
        [DocumentReviewActionEntity, { save: vi.fn(async (value) => value) }],
      ]),
    );
    const ingestion = {
      createSearchProjectionIntent: vi.fn(async (_manager, target) => {
        target.searchProjectionVersion += 1;
      }),
      dispatchPending: vi.fn(),
    };
    const service = new DocumentReviewsService(
      { transaction: vi.fn(async (callback) => callback(manager)) } as never,
      {
        assertDocumentReview: vi.fn(),
        recordAudit: vi.fn(async () => undefined),
      } as never,
      ingestion as never,
    );
    vi.spyOn(service as never, 'findReview' as never).mockResolvedValue({
      id: reviewId,
    } as never);

    await service.approve(auth, reviewId, 'Approved');

    expect(review.status).toBe('approved');
    expect(document.currentReadyVersionId).toBe(nextVersionId);
    expect(document.status).toBe('published');
    expect(ingestion.createSearchProjectionIntent).toHaveBeenCalledWith(
      manager,
      document,
      'review-approved',
    );
    expect(ingestion.dispatchPending).toHaveBeenCalledOnce();
  });
});

function publishedDocument() {
  return {
    id: documentId,
    tenantId: auth.tenantId,
    status: 'published' as const,
    currentReadyVersionId: oldVersionId,
    searchProjectionVersion: 1,
    deletedAt: null,
  };
}

function readyVersion() {
  return {
    id: nextVersionId,
    tenantId: auth.tenantId,
    documentId,
    versionNo: 2,
    sourceFilename: 'version-2.md',
    ingestionStatus: 'ready' as const,
  };
}

function fakeManager(repositories: Map<unknown, unknown>) {
  return {
    getRepository: vi.fn((entity: unknown) => {
      const repository = repositories.get(entity);
      if (!repository) {
        if (entity === AppUserEntity) return { findBy: vi.fn(async () => []) };
        throw new Error(`Missing fake repository for ${String(entity)}`);
      }
      return repository;
    }),
  };
}
