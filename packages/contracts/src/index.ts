import { z } from 'zod';

export const ApiMetaSchema = z.object({ requestId: z.string(), timestamp: z.string() });
export type ApiMeta = z.infer<typeof ApiMetaSchema>;

export type ApiSuccess<T> = { ok: true; data: T; meta: ApiMeta };
export type ApiFailure = { ok: false; error: { code: string; message: string }; meta: ApiMeta };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function buildSuccess<T>(data: T, requestId = crypto.randomUUID()): ApiSuccess<T> {
  return { ok: true, data, meta: { requestId, timestamp: new Date().toISOString() } };
}

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  timestamp: z.string(),
  dependencies: z.record(z.string(), z.literal('ok')).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const AuthSessionResponseSchema = z.object({
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  principalIds: z.array(z.string().min(1)),
  mode: z.enum(['demo', 'jwt']),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const accessPermissionKeys = [
  'access.manage',
  'system.manage',
  'knowledge.manage',
  'documents.create',
  'documents.read',
  'documents.update',
  'documents.delete',
  'documents.manage',
  'documents.share',
  'documents.review',
] as const;
export const AccessPermissionKeySchema = z.enum(accessPermissionKeys);
export type AccessPermissionKey = z.infer<typeof AccessPermissionKeySchema>;

export const accessPrincipalTypes = ['tenant', 'user', 'department', 'role'] as const;
export const AccessPrincipalTypeSchema = z.enum(accessPrincipalTypes);
export type AccessPrincipalType = z.infer<typeof AccessPrincipalTypeSchema>;
export const AccessPrincipalIdSchema = z
  .string()
  .trim()
  .regex(
    /^(?:tenant|user|department|role):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

export const DOCUMENT_INGESTION_QUEUE = 'document-ingestion';
export const DOCUMENT_INGESTION_JOB = 'ingest-document';
export const DOCUMENT_CLEANUP_QUEUE = 'document-cleanup';
export const DOCUMENT_CLEANUP_JOB = 'cleanup-document';
export const DOCUMENT_ACL_PROJECTION_QUEUE = 'document-acl-projection';
export const DOCUMENT_ACL_PROJECTION_JOB = 'project-document-acl';
export const DOCUMENT_SEARCH_PROJECTION_QUEUE = 'document-search-projection';
export const DOCUMENT_SEARCH_PROJECTION_JOB = 'project-document-search';
export const MAX_DOCUMENT_INGESTION_ATTEMPTS = 3;

export const outboxEventTypes = [
  'document.ingestion.requested',
  'document.cleanup.requested',
  'document.acl.changed',
  'document.search-projection.requested',
] as const;
export const OutboxEventTypeSchema = z.enum(outboxEventTypes);
export type OutboxEventType = z.infer<typeof OutboxEventTypeSchema>;

export const ingestionStatuses = [
  'received',
  'stored',
  'parsing',
  'normalizing',
  'chunking',
  'indexing',
  'ready',
  'retrying',
  'failed',
  'cancelled',
] as const;
export const IngestionStatusSchema = z.enum(ingestionStatuses);
export type IngestionStatus = z.infer<typeof IngestionStatusSchema>;

export const documentStatuses = ['draft', 'published', 'archived'] as const;
export const DocumentStatusSchema = z.enum(documentStatuses);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentIngestionJobSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  sourceBucket: z.string().min(3),
  sourceObjectKey: z.string().min(1),
  sourceFilename: z.string().min(1),
  mimeType: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  generation: z.number().int().positive(),
  requestedAt: z.string().datetime(),
});
export type DocumentIngestionJob = z.infer<typeof DocumentIngestionJobSchema>;

export const DocumentCleanupJobSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  requestedAt: z.string().datetime(),
});
export type DocumentCleanupJob = z.infer<typeof DocumentCleanupJobSchema>;

export const DocumentAclProjectionJobSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  aclVersion: z.number().int().positive(),
  requestedAt: z.string().datetime(),
});
export type DocumentAclProjectionJob = z.infer<typeof DocumentAclProjectionJobSchema>;

export const DocumentSearchProjectionJobSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  projectionVersion: z.number().int().positive(),
  reason: z.enum(['organization', 'tags', 'publish', 'review-approved']),
  requestedAt: z.string().datetime(),
});
export type DocumentSearchProjectionJob = z.infer<typeof DocumentSearchProjectionJobSchema>;
export type DocumentSearchProjectionReason = DocumentSearchProjectionJob['reason'];

export function documentIngestionQueueJobId(versionId: string, generation: number): string {
  return `${versionId}-${generation}`;
}

export function documentCleanupQueueJobId(documentId: string): string {
  return `cleanup-${documentId}`;
}

export function documentAclProjectionQueueJobId(documentId: string, aclVersion: number): string {
  return `acl-${documentId}-${aclVersion}`;
}

export function documentSearchProjectionQueueJobId(
  documentId: string,
  projectionVersion: number,
): string {
  return `search-${documentId}-${projectionVersion}`;
}

export const EnqueueIngestionJobResponseSchema = z.object({
  jobId: z.string(),
  status: z.literal('queued'),
});
export type EnqueueIngestionJobResponse = z.infer<typeof EnqueueIngestionJobResponseSchema>;

export const CreateDocumentUploadRequestSchema = z.object({
  tenantId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  spaceId: z.string().uuid().optional(),
  folderId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(500),
  sourceFilename: z.string().trim().min(1).max(1024),
  mimeType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  createdBy: z.string().uuid().optional(),
  principalIds: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
});
export type CreateDocumentUploadRequest = z.infer<typeof CreateDocumentUploadRequestSchema>;

export const CreateDocumentUploadResponseSchema = z.object({
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  uploadUrl: z.string().url(),
  uploadHeaders: z.record(z.string(), z.string()),
  expiresInSeconds: z.number().int().positive(),
});
export type CreateDocumentUploadResponse = z.infer<typeof CreateDocumentUploadResponseSchema>;

export const CompleteDocumentUploadRequestSchema = z.object({
  tenantId: z.string().uuid().optional(),
});
export type CompleteDocumentUploadRequest = z.infer<typeof CompleteDocumentUploadRequestSchema>;

export const CompleteDocumentUploadResponseSchema = z.object({
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  jobId: z.string(),
  status: z.enum(['queued', 'ready']),
});
export type CompleteDocumentUploadResponse = z.infer<typeof CompleteDocumentUploadResponseSchema>;

export const TenantCommandRequestSchema = z.object({ tenantId: z.string().uuid().optional() });
export type TenantCommandRequest = z.infer<typeof TenantCommandRequestSchema>;

export const IngestionCommandResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(['queued', 'cancelled']),
});
export type IngestionCommandResponse = z.infer<typeof IngestionCommandResponseSchema>;

export const PublishDocumentVersionResponseSchema = z.object({
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  status: z.literal('published'),
  projectionStatus: z.literal('queued'),
});
export type PublishDocumentVersionResponse = z.infer<typeof PublishDocumentVersionResponseSchema>;

export const documentReviewStatuses = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export const DocumentReviewStatusSchema = z.enum(documentReviewStatuses);
export type DocumentReviewStatus = z.infer<typeof DocumentReviewStatusSchema>;

export const documentReviewActions = ['submitted', 'approved', 'rejected', 'withdrawn'] as const;
export const DocumentReviewActionSchema = z.enum(documentReviewActions);
export type DocumentReviewAction = z.infer<typeof DocumentReviewActionSchema>;

export const SubmitDocumentReviewRequestSchema = z.object({
  comment: z.string().trim().min(1).max(2_000).nullable().optional(),
});
export type SubmitDocumentReviewRequest = z.infer<typeof SubmitDocumentReviewRequestSchema>;

export const WithdrawDocumentReviewRequestSchema = z.object({
  comment: z.string().trim().min(1).max(2_000).nullable().optional(),
});
export type WithdrawDocumentReviewRequest = z.infer<typeof WithdrawDocumentReviewRequestSchema>;

export const ApproveDocumentReviewRequestSchema = z.object({
  comment: z.string().trim().min(1).max(2_000).nullable().optional(),
});
export type ApproveDocumentReviewRequest = z.infer<typeof ApproveDocumentReviewRequestSchema>;

export const RejectDocumentReviewRequestSchema = z.object({
  comment: z.string().trim().min(1).max(2_000),
});
export type RejectDocumentReviewRequest = z.infer<typeof RejectDocumentReviewRequestSchema>;

export const DocumentReviewQuerySchema = z.object({
  status: z.union([DocumentReviewStatusSchema, z.literal('all')]).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type DocumentReviewQuery = z.infer<typeof DocumentReviewQuerySchema>;

export const DocumentReviewActionItemSchema = z.object({
  id: z.string().uuid(),
  action: DocumentReviewActionSchema,
  actorId: z.string().uuid(),
  actorName: z.string().nullable(),
  comment: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type DocumentReviewActionItem = z.infer<typeof DocumentReviewActionItemSchema>;

export const DocumentReviewItemSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  documentTitle: z.string(),
  versionNo: z.number().int().positive(),
  sourceFilename: z.string(),
  status: DocumentReviewStatusSchema,
  submittedBy: z.string().uuid(),
  submittedByName: z.string().nullable(),
  submittedAt: z.string().datetime(),
  resolvedBy: z.string().uuid().nullable(),
  resolvedByName: z.string().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  decisionComment: z.string().nullable(),
  actions: z.array(DocumentReviewActionItemSchema),
});
export type DocumentReviewItem = z.infer<typeof DocumentReviewItemSchema>;

export const DocumentReviewListResponseSchema = z.object({
  items: z.array(DocumentReviewItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type DocumentReviewListResponse = z.infer<typeof DocumentReviewListResponseSchema>;

export const DeleteDocumentResponseSchema = z.object({
  documentId: z.string().uuid(),
  status: z.literal('archived'),
});
export type DeleteDocumentResponse = z.infer<typeof DeleteDocumentResponseSchema>;

export const DocumentQuerySchema = z.object({
  tenantId: z.string().uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  title: z.string().trim().min(1).optional(),
  spaceId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  tagIds: z.preprocess(
    (value) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value),
    z.array(z.string().uuid()).max(20).optional(),
  ),
});
export type DocumentQuery = z.infer<typeof DocumentQuerySchema>;

export const SearchDocumentsRequestSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  page: z.number().int().min(1).max(20).default(1),
  limit: z.number().int().min(1).max(50).default(10),
  spaceId: z.string().uuid().optional(),
  folderId: z.string().uuid().optional(),
  tagIds: z.array(z.string().uuid()).max(20).optional(),
  includeDiagnostics: z.boolean().optional(),
});
export type SearchDocumentsRequest = z.infer<typeof SearchDocumentsRequestSchema>;

export const SearchSourceSchema = z.object({
  type: z.enum(['document', 'heading', 'page', 'slide', 'sheet']),
  page: z.number().int().positive().nullable(),
  slide: z.number().int().positive().nullable(),
  sheet: z.string().nullable(),
  rowStart: z.number().int().positive().nullable(),
  rowEnd: z.number().int().positive().nullable(),
  heading: z.string().nullable(),
  offsetStart: z.number().int().nonnegative(),
  offsetEnd: z.number().int().nonnegative(),
});
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchDocumentHitSchema = z.object({
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  title: z.string(),
  content: z.string(),
  score: z.number(),
  source: SearchSourceSchema,
});
export type SearchDocumentHit = z.infer<typeof SearchDocumentHitSchema>;

export const SearchDiagnosticsStageSchema = z.object({
  candidateCount: z.number().int().nonnegative(),
  hits: z.array(SearchDocumentHitSchema),
});
export type SearchDiagnosticsStage = z.infer<typeof SearchDiagnosticsStageSchema>;

export const SearchDiagnosticsSchema = z.object({
  candidateLimit: z.number().int().positive(),
  scoreThreshold: z.number().nonnegative(),
  mmrLambda: z.number().min(0).max(1),
  nearDuplicateThreshold: z.number().min(0).max(1),
  consolidation: z.object({
    exactDuplicatesRemoved: z.number().int().nonnegative(),
    adjacentChunksMerged: z.number().int().nonnegative(),
    nonAdjacentDuplicatesRemoved: z.number().int().nonnegative(),
    crossSourceSimilarPreserved: z.number().int().nonnegative(),
  }),
  timingsMs: z.object({
    settings: z.number().int().nonnegative(),
    embedding: z.number().int().nonnegative(),
    vector: z.number().int().nonnegative(),
    keyword: z.number().int().nonnegative(),
    fusion: z.number().int().nonnegative(),
    hydration: z.number().int().nonnegative(),
    rerank: z.number().int().nonnegative(),
    consolidation: z.number().int().nonnegative(),
    mmr: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  stages: z.object({
    vector: SearchDiagnosticsStageSchema,
    keyword: SearchDiagnosticsStageSchema,
    rrf: SearchDiagnosticsStageSchema,
    reranked: SearchDiagnosticsStageSchema,
    consolidated: SearchDiagnosticsStageSchema,
    selected: SearchDiagnosticsStageSchema,
  }),
});
export type SearchDiagnostics = z.infer<typeof SearchDiagnosticsSchema>;

export const SearchFacetValueSchema = z.object({
  id: z.string().uuid(),
  count: z.number().int().nonnegative(),
});
export type SearchFacetValue = z.infer<typeof SearchFacetValueSchema>;

export const SearchFacetsSchema = z.object({
  spaces: z.array(SearchFacetValueSchema),
  folders: z.array(SearchFacetValueSchema),
  tags: z.array(SearchFacetValueSchema),
});
export type SearchFacets = z.infer<typeof SearchFacetsSchema>;

export const SearchDocumentsResponseSchema = z.object({
  queryEventId: z.string().uuid().nullable(),
  query: z.string(),
  hits: z.array(SearchDocumentHitSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  facets: SearchFacetsSchema,
  diagnostics: SearchDiagnosticsSchema.optional(),
});
export type SearchDocumentsResponse = z.infer<typeof SearchDocumentsResponseSchema>;

export const SearchPreferencesResponseSchema = z.object({
  pageSize: z.number().int().min(5).max(50),
  feedbackEnabled: z.boolean(),
});
export type SearchPreferencesResponse = z.infer<typeof SearchPreferencesResponseSchema>;

export const SearchFeedbackRatingSchema = z.enum(['helpful', 'unhelpful']);
export type SearchFeedbackRating = z.infer<typeof SearchFeedbackRatingSchema>;

export const SearchFeedbackReasonSchema = z.enum([
  'irrelevant',
  'incomplete',
  'outdated',
  'incorrect',
  'other',
]);
export type SearchFeedbackReason = z.infer<typeof SearchFeedbackReasonSchema>;

export const SubmitSearchFeedbackRequestSchema = z.object({
  queryEventId: z.string().uuid(),
  rating: SearchFeedbackRatingSchema,
  reason: SearchFeedbackReasonSchema.nullable().optional(),
  comment: z.string().trim().max(1_000).nullable().optional(),
});
export type SubmitSearchFeedbackRequest = z.infer<typeof SubmitSearchFeedbackRequestSchema>;

export const SubmitSearchFeedbackResponseSchema = z.object({
  feedbackId: z.string().uuid(),
  queryEventId: z.string().uuid(),
  rating: SearchFeedbackRatingSchema,
});
export type SubmitSearchFeedbackResponse = z.infer<typeof SubmitSearchFeedbackResponseSchema>;

export const SearchGovernanceQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});
export type SearchGovernanceQuery = z.infer<typeof SearchGovernanceQuerySchema>;

export const SearchQuerySourceSchema = z.enum(['search', 'answer']);
export type SearchQuerySource = z.infer<typeof SearchQuerySourceSchema>;

export const SearchGovernanceQueryItemSchema = z.object({
  query: z.string(),
  count: z.number().int().positive(),
  zeroResultCount: z.number().int().nonnegative(),
  averageDurationMs: z.number().nonnegative(),
});
export type SearchGovernanceQueryItem = z.infer<typeof SearchGovernanceQueryItemSchema>;

export const SearchGovernanceRecentItemSchema = z.object({
  id: z.string().uuid(),
  query: z.string(),
  source: SearchQuerySourceSchema,
  resultCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  status: z.enum(['success', 'failed']),
  createdAt: z.string().datetime(),
});
export type SearchGovernanceRecentItem = z.infer<typeof SearchGovernanceRecentItemSchema>;

export const SearchGovernanceResponseSchema = z.object({
  windowDays: z.number().int().positive(),
  totalQueries: z.number().int().nonnegative(),
  directSearchQueries: z.number().int().nonnegative(),
  answerQueries: z.number().int().nonnegative(),
  failedQueries: z.number().int().nonnegative(),
  zeroResultQueries: z.number().int().nonnegative(),
  zeroResultRate: z.number().min(0).max(1),
  averageDurationMs: z.number().nonnegative(),
  p95DurationMs: z.number().nonnegative(),
  averageResultCount: z.number().nonnegative(),
  topQueries: z.array(SearchGovernanceQueryItemSchema),
  noResultQueries: z.array(SearchGovernanceQueryItemSchema),
  recentQueries: z.array(SearchGovernanceRecentItemSchema),
});
export type SearchGovernanceResponse = z.infer<typeof SearchGovernanceResponseSchema>;

export const SystemRetrievalSettingsSchema = z.object({
  candidateLimit: z.number().int().min(50).max(500),
  scoreThreshold: z.number().min(0).max(1),
  defaultPageSize: z.number().int().min(5).max(50),
  feedbackEnabled: z.boolean(),
});
export type SystemRetrievalSettings = z.infer<typeof SystemRetrievalSettingsSchema>;

export const SystemGovernanceSettingsSchema = z.object({
  auditRetentionDays: z.number().int().min(30).max(3_650),
});
export type SystemGovernanceSettings = z.infer<typeof SystemGovernanceSettingsSchema>;

export const UpdateSystemSettingsRequestSchema = z.object({
  retrieval: SystemRetrievalSettingsSchema,
  governance: SystemGovernanceSettingsSchema,
});
export type UpdateSystemSettingsRequest = z.infer<typeof UpdateSystemSettingsRequestSchema>;

export const SystemRuntimeConfigurationSchema = z.object({
  modelProvider: z.string(),
  embeddingModel: z.string(),
  chatModel: z.string(),
  rerankerProvider: z.string(),
  rerankerModel: z.string(),
  mmrLambda: z.number().min(0).max(1),
  nearDuplicateThreshold: z.number().min(0).max(1),
  modelRequestTimeoutMs: z.number().int().positive(),
  modelRequestsPerMinute: z.number().int().nonnegative(),
  ragMinRelevance: z.number().min(0).max(1),
  maxUploadSizeBytes: z.number().int().positive(),
  chatRetentionDays: z.number().int().positive(),
  elasticsearchIndex: z.string(),
});
export type SystemRuntimeConfiguration = z.infer<typeof SystemRuntimeConfigurationSchema>;

export const SystemSettingsResponseSchema = z.object({
  tenantId: z.string().uuid(),
  version: z.number().int().positive(),
  retrieval: SystemRetrievalSettingsSchema,
  governance: SystemGovernanceSettingsSchema,
  runtime: SystemRuntimeConfigurationSchema,
  canEdit: z.boolean(),
  updatedBy: z.string().uuid().nullable(),
  updatedAt: z.string().datetime().nullable(),
});
export type SystemSettingsResponse = z.infer<typeof SystemSettingsResponseSchema>;

export const AuditEventQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(30),
  action: z.string().trim().min(1).max(128).optional(),
  resourceType: z.string().trim().min(1).max(64).optional(),
});
export type AuditEventQuery = z.infer<typeof AuditEventQuerySchema>;

export const AuditEventItemSchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type AuditEventItem = z.infer<typeof AuditEventItemSchema>;

export const AuditEventListResponseSchema = z.object({
  items: z.array(AuditEventItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type AuditEventListResponse = z.infer<typeof AuditEventListResponseSchema>;

export const QualityGovernanceQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
export type QualityGovernanceQuery = z.infer<typeof QualityGovernanceQuerySchema>;

export const ModelOperationSummarySchema = z.object({
  operation: z.string(),
  model: z.string(),
  calls: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  averageDurationMs: z.number().nonnegative(),
  averageFirstTokenDurationMs: z.number().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
});
export type ModelOperationSummary = z.infer<typeof ModelOperationSummarySchema>;

export const QualityCostResponseSchema = z.object({
  windowDays: z.number().int().positive(),
  search: z.object({
    totalQueries: z.number().int().nonnegative(),
    zeroResultRate: z.number().min(0).max(1),
    averageDurationMs: z.number().nonnegative(),
    averageResultCount: z.number().nonnegative(),
  }),
  feedback: z.object({
    total: z.number().int().nonnegative(),
    helpful: z.number().int().nonnegative(),
    unhelpful: z.number().int().nonnegative(),
    helpfulRate: z.number().min(0).max(1),
    reasons: z.array(
      z.object({
        reason: SearchFeedbackReasonSchema.nullable(),
        count: z.number().int().positive(),
      }),
    ),
  }),
  models: z.object({
    startedAt: z.string().datetime(),
    totalCalls: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    operations: z.array(ModelOperationSummarySchema),
  }),
});
export type QualityCostResponse = z.infer<typeof QualityCostResponseSchema>;

export const AskQuestionRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  question: z.string().trim().min(1).max(4_000),
  limit: z.number().int().min(1).max(12).default(6),
  includeDiagnostics: z.boolean().optional(),
});
export type AskQuestionRequest = z.infer<typeof AskQuestionRequestSchema>;

export const AnswerCitationSchema = z.object({
  ordinal: z.number().int().positive(),
  chunkId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentVersionId: z.string().uuid(),
  title: z.string(),
  excerpt: z.string(),
  source: SearchSourceSchema,
});
export type AnswerCitation = z.infer<typeof AnswerCitationSchema>;

export const AskQuestionResponseSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  answer: z.string(),
  grounded: z.boolean(),
  model: z.string(),
  citations: z.array(AnswerCitationSchema),
  retrievalDiagnostics: SearchDiagnosticsSchema.optional(),
});
export type AskQuestionResponse = z.infer<typeof AskQuestionResponseSchema>;

export const ConversationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ConversationQuery = z.infer<typeof ConversationQuerySchema>;

export const ConversationSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListResponseSchema = z.object({
  items: z.array(ConversationSummarySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;

export const ConversationMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  model: z.string().nullable(),
  createdAt: z.string().datetime(),
  citations: z.array(AnswerCitationSchema),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationDetailResponseSchema = ConversationSummarySchema.extend({
  messages: z.array(ConversationMessageSchema),
});
export type ConversationDetailResponse = z.infer<typeof ConversationDetailResponseSchema>;

export const DeleteConversationResponseSchema = z.object({
  conversationId: z.string().uuid(),
  deleted: z.literal(true),
});
export type DeleteConversationResponse = z.infer<typeof DeleteConversationResponseSchema>;

export const UpsertOrganizationMemberRequestSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().trim().min(1).max(255),
  email: z.string().trim().email().max(320).nullable().optional(),
});
export type UpsertOrganizationMemberRequest = z.infer<typeof UpsertOrganizationMemberRequestSchema>;

export const CreateAccessRoleRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(1_000).nullable().optional(),
  permissionKeys: z.array(AccessPermissionKeySchema).max(accessPermissionKeys.length).default([]),
});
export type CreateAccessRoleRequest = z.infer<typeof CreateAccessRoleRequestSchema>;

export const AssignMemberRolesRequestSchema = z.object({
  roleIds: z.array(z.string().uuid()).max(100),
});
export type AssignMemberRolesRequest = z.infer<typeof AssignMemberRolesRequestSchema>;

export const CreateDepartmentRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(1_000).nullable().optional(),
});
export type CreateDepartmentRequest = z.infer<typeof CreateDepartmentRequestSchema>;

export const AssignDepartmentMembersRequestSchema = z.object({
  userIds: z.array(z.string().uuid()).max(1_000),
});
export type AssignDepartmentMembersRequest = z.infer<typeof AssignDepartmentMembersRequestSchema>;

export const ReplaceDocumentAclRequestSchema = z.object({
  principalIds: z.array(AccessPrincipalIdSchema).min(1).max(100),
});
export type ReplaceDocumentAclRequest = z.infer<typeof ReplaceDocumentAclRequestSchema>;

export const OrganizationMemberSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  roleIds: z.array(z.string().uuid()),
  departmentIds: z.array(z.string().uuid()),
});
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;

export const AccessRoleSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isSystem: z.boolean(),
  permissionKeys: z.array(AccessPermissionKeySchema),
  memberCount: z.number().int().nonnegative(),
});
export type AccessRole = z.infer<typeof AccessRoleSchema>;

export const AccessPermissionSchema = z.object({
  key: AccessPermissionKeySchema,
  name: z.string(),
  description: z.string(),
});
export type AccessPermission = z.infer<typeof AccessPermissionSchema>;

export const OrganizationDepartmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  memberIds: z.array(z.string().uuid()),
});
export type OrganizationDepartment = z.infer<typeof OrganizationDepartmentSchema>;

export const AccessDocumentSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: DocumentStatusSchema,
  aclVersion: z.number().int().positive(),
  principalIds: z.array(AccessPrincipalIdSchema),
});
export type AccessDocumentSummary = z.infer<typeof AccessDocumentSummarySchema>;

export const AccessOverviewResponseSchema = z.object({
  tenant: z.object({ id: z.string().uuid(), name: z.string() }),
  members: z.array(OrganizationMemberSchema),
  roles: z.array(AccessRoleSchema),
  permissions: z.array(AccessPermissionSchema),
  departments: z.array(OrganizationDepartmentSchema),
  documents: z.array(AccessDocumentSummarySchema),
});
export type AccessOverviewResponse = z.infer<typeof AccessOverviewResponseSchema>;

export const ReplaceDocumentAclResponseSchema = z.object({
  documentId: z.string().uuid(),
  aclVersion: z.number().int().positive(),
  principalIds: z.array(AccessPrincipalIdSchema),
  projectionStatus: z.literal('queued'),
});
export type ReplaceDocumentAclResponse = z.infer<typeof ReplaceDocumentAclResponseSchema>;

export const CreateKnowledgeSpaceRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2_000).nullable().optional(),
  principalIds: z.array(AccessPrincipalIdSchema).min(1).max(100),
});
export type CreateKnowledgeSpaceRequest = z.infer<typeof CreateKnowledgeSpaceRequestSchema>;

export const UpdateKnowledgeSpaceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: 'At least one space field is required',
  });
export type UpdateKnowledgeSpaceRequest = z.infer<typeof UpdateKnowledgeSpaceRequestSchema>;

export const CreateKnowledgeFolderRequestSchema = z.object({
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(2_000).nullable().optional(),
});
export type CreateKnowledgeFolderRequest = z.infer<typeof CreateKnowledgeFolderRequestSchema>;

export const UpdateKnowledgeFolderRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.description !== undefined || value.parentId !== undefined,
    { message: 'At least one folder field is required' },
  );
export type UpdateKnowledgeFolderRequest = z.infer<typeof UpdateKnowledgeFolderRequestSchema>;

export const CreateKnowledgeTagRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  description: z.string().trim().max(1_000).nullable().optional(),
});
export type CreateKnowledgeTagRequest = z.infer<typeof CreateKnowledgeTagRequestSchema>;

export const UpdateKnowledgeTagRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    description: z.string().trim().max(1_000).nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.color !== undefined || value.description !== undefined,
    { message: 'At least one tag field is required' },
  );
export type UpdateKnowledgeTagRequest = z.infer<typeof UpdateKnowledgeTagRequestSchema>;

export const MoveDocumentRequestSchema = z
  .object({
    spaceId: z.string().uuid().nullable(),
    folderId: z.string().uuid().nullable(),
  })
  .refine((value) => value.folderId === null || value.spaceId !== null, {
    message: 'A folder requires a knowledge space',
  });
export type MoveDocumentRequest = z.infer<typeof MoveDocumentRequestSchema>;

export const ReplaceDocumentTagsRequestSchema = z.object({
  tagIds: z.array(z.string().uuid()).max(50),
});
export type ReplaceDocumentTagsRequest = z.infer<typeof ReplaceDocumentTagsRequestSchema>;

export const ReplaceContainerAclRequestSchema = z.object({
  principalIds: z.array(AccessPrincipalIdSchema).max(100),
});
export type ReplaceContainerAclRequest = z.infer<typeof ReplaceContainerAclRequestSchema>;

export const KnowledgeSpaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  principalIds: z.array(AccessPrincipalIdSchema),
});
export type KnowledgeSpace = z.infer<typeof KnowledgeSpaceSchema>;

export const KnowledgeFolderSchema = z.object({
  id: z.string().uuid(),
  spaceId: z.string().uuid(),
  parentId: z.string().uuid().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  principalIds: z.array(AccessPrincipalIdSchema),
  directPrincipalIds: z.array(AccessPrincipalIdSchema),
});
export type KnowledgeFolder = z.infer<typeof KnowledgeFolderSchema>;

export const KnowledgeTagSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  color: z.string(),
  description: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
});
export type KnowledgeTag = z.infer<typeof KnowledgeTagSchema>;

export const OrganizedDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: DocumentStatusSchema,
  spaceId: z.string().uuid().nullable(),
  folderId: z.string().uuid().nullable(),
  tagIds: z.array(z.string().uuid()),
  aclVersion: z.number().int().positive(),
  searchProjectionVersion: z.number().int().positive(),
});
export type OrganizedDocument = z.infer<typeof OrganizedDocumentSchema>;

export const KnowledgeOverviewResponseSchema = z.object({
  spaces: z.array(KnowledgeSpaceSchema),
  folders: z.array(KnowledgeFolderSchema),
  tags: z.array(KnowledgeTagSchema),
  documents: z.array(OrganizedDocumentSchema),
});
export type KnowledgeOverviewResponse = z.infer<typeof KnowledgeOverviewResponseSchema>;
