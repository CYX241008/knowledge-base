import { describe, expect, it } from 'vitest';
import {
  DocumentAclProjectionJobSchema,
  DocumentIngestionJobSchema,
  DocumentSearchProjectionJobSchema,
  MoveDocumentRequestSchema,
  ReplaceDocumentAclRequestSchema,
  SearchDocumentsRequestSchema,
  SearchDocumentsResponseSchema,
  SubmitSearchFeedbackRequestSchema,
  UpdateSystemSettingsRequestSchema,
  documentAclProjectionQueueJobId,
  documentCleanupQueueJobId,
  documentIngestionQueueJobId,
  documentSearchProjectionQueueJobId,
} from './index';

describe('reliable queue contracts', () => {
  it('uses the ingestion generation to isolate retries', () => {
    const versionId = '11111111-1111-4111-8111-111111111111';
    expect(documentIngestionQueueJobId(versionId, 1)).toBe(`${versionId}-1`);
    expect(documentIngestionQueueJobId(versionId, 2)).toBe(`${versionId}-2`);
    expect(documentCleanupQueueJobId(versionId)).toBe(`cleanup-${versionId}`);
    expect(documentAclProjectionQueueJobId(versionId, 3)).toBe(`acl-${versionId}-3`);
  });

  it('creates stable search projection job identifiers', () => {
    const documentId = '22222222-2222-4222-8222-222222222222';
    expect(documentSearchProjectionQueueJobId(documentId, 4)).toBe(`search-${documentId}-4`);
    expect(
      DocumentSearchProjectionJobSchema.safeParse({
        tenantId: '11111111-1111-4111-8111-111111111111',
        documentId,
        projectionVersion: 4,
        reason: 'tags',
        requestedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it('validates ACL projection versions and typed principals', () => {
    const payload = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      aclVersion: 2,
      requestedAt: new Date().toISOString(),
    };
    expect(DocumentAclProjectionJobSchema.safeParse(payload).success).toBe(true);
    expect(DocumentAclProjectionJobSchema.safeParse({ ...payload, aclVersion: 0 }).success).toBe(
      false,
    );
    expect(
      ReplaceDocumentAclRequestSchema.safeParse({
        principalIds: ['role:33333333-3333-4333-8333-333333333333'],
      }).success,
    ).toBe(true);
    expect(
      ReplaceDocumentAclRequestSchema.safeParse({ principalIds: ['permission:access.manage'] })
        .success,
    ).toBe(false);
  });

  it('requires folders to belong to a selected space', () => {
    expect(MoveDocumentRequestSchema.safeParse({ spaceId: null, folderId: null }).success).toBe(
      true,
    );
    expect(
      MoveDocumentRequestSchema.safeParse({
        spaceId: null,
        folderId: '33333333-3333-4333-8333-333333333333',
      }).success,
    ).toBe(false);
  });

  it('requires a positive generation in ingestion payloads', () => {
    const payload = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      documentId: '22222222-2222-4222-8222-222222222222',
      documentVersionId: '33333333-3333-4333-8333-333333333333',
      sourceBucket: 'knowledge-base',
      sourceObjectKey: 'tenants/source.txt',
      sourceFilename: 'source.txt',
      mimeType: 'text/plain',
      sha256: 'a'.repeat(64),
      requestedAt: new Date().toISOString(),
    };
    expect(DocumentIngestionJobSchema.safeParse({ ...payload, generation: 1 }).success).toBe(true);
    expect(DocumentIngestionJobSchema.safeParse({ ...payload, generation: 0 }).success).toBe(false);
  });

  it('strips client-supplied identity fields from search input', () => {
    expect(
      SearchDocumentsRequestSchema.parse({
        tenantId: '11111111-1111-4111-8111-111111111111',
        principalIds: ['role:reader'],
        text: 'vector retrieval',
        limit: 10,
      }),
    ).toEqual({ text: 'vector retrieval', page: 1, limit: 10 });
  });

  it('requires a query event identity in search responses', () => {
    const response = {
      queryEventId: '11111111-1111-4111-8111-111111111111',
      query: 'governed retrieval',
      hits: [],
      total: 0,
      page: 1,
      pageSize: 10,
      durationMs: 12,
      facets: { spaces: [], folders: [], tags: [] },
    };
    expect(SearchDocumentsResponseSchema.safeParse(response).success).toBe(true);
    expect(
      SearchDocumentsResponseSchema.safeParse({ ...response, queryEventId: undefined }).success,
    ).toBe(false);
  });

  it('validates tenant retrieval and audit settings', () => {
    const settings = {
      retrieval: {
        candidateLimit: 200,
        scoreThreshold: 0.15,
        defaultPageSize: 10,
        feedbackEnabled: true,
      },
      governance: { auditRetentionDays: 365 },
    };
    expect(UpdateSystemSettingsRequestSchema.safeParse(settings).success).toBe(true);
    expect(
      UpdateSystemSettingsRequestSchema.safeParse({
        ...settings,
        retrieval: { ...settings.retrieval, candidateLimit: 501 },
      }).success,
    ).toBe(false);
    expect(
      UpdateSystemSettingsRequestSchema.safeParse({
        ...settings,
        governance: { auditRetentionDays: 29 },
      }).success,
    ).toBe(false);
  });

  it('accepts structured search feedback and rejects unknown reasons', () => {
    const feedback = {
      queryEventId: '11111111-1111-4111-8111-111111111111',
      rating: 'unhelpful',
      reason: 'incomplete',
      comment: 'Missing the current operating procedure',
    };
    expect(SubmitSearchFeedbackRequestSchema.safeParse(feedback).success).toBe(true);
    expect(
      SubmitSearchFeedbackRequestSchema.safeParse({ ...feedback, reason: 'slow' }).success,
    ).toBe(false);
  });
});
