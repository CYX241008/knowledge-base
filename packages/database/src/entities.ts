import type {
  AccessPermissionKey,
  AccessPermissionScope,
  AccessPrincipalType,
  DocumentStatus,
  DocumentReviewAction,
  DocumentReviewStatus,
  IngestionStatus,
  OutboxEventType,
  SearchFeedbackRating,
  SearchFeedbackReason,
  SearchQuerySource,
} from '@knowledge-base/contracts';
import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

const numberFromBigint = {
  to: (value: number): number => value,
  from: (value: string | number): number => Number(value),
};

@Entity('tenant')
export class TenantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('varchar', { length: 255 })
  name!: string;

  @Column('varchar', { length: 32, default: 'active' })
  status!: 'active' | 'inactive';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('app_user')
@Index(['tenantId', 'displayName'])
export class AppUserEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'display_name', length: 255 })
  displayName!: string;

  @Column('varchar', { length: 320, nullable: true })
  email!: string | null;

  @Column('varchar', { length: 32, default: 'active' })
  status!: 'active' | 'inactive';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('department')
@Index(['tenantId', 'name'], { unique: true })
export class DepartmentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { length: 255 })
  name!: string;

  @Column('text', { nullable: true })
  description!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('department_member')
@Index(['tenantId', 'userId'])
export class DepartmentMemberEntity {
  @PrimaryColumn('uuid', { name: 'department_id' })
  departmentId!: string;

  @PrimaryColumn('uuid', { name: 'user_id' })
  userId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('access_role')
@Index(['tenantId', 'name'], { unique: true })
export class AccessRoleEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { length: 128 })
  name!: string;

  @Column('text', { nullable: true })
  description!: string | null;

  @Column('boolean', { name: 'is_system', default: false })
  isSystem!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('access_permission')
export class AccessPermissionEntity {
  @PrimaryColumn('varchar', { length: 128 })
  key!: AccessPermissionKey;

  @Column('varchar', { length: 255 })
  name!: string;

  @Column('text')
  description!: string;

  @Column('varchar', { length: 16, default: 'resource' })
  scope!: AccessPermissionScope;
}

@Entity('user_role')
@Index(['tenantId', 'roleId'])
export class UserRoleEntity {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId!: string;

  @PrimaryColumn('uuid', { name: 'role_id' })
  roleId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('role_permission')
export class RolePermissionEntity {
  @PrimaryColumn('uuid', { name: 'role_id' })
  roleId!: string;

  @PrimaryColumn('varchar', { name: 'permission_key', length: 128 })
  permissionKey!: AccessPermissionKey;
}

@Entity('resource_acl')
@Index(['tenantId', 'resourceType', 'resourceId'])
@Index(['tenantId', 'resourceType', 'resourceId', 'principalId', 'permission'], { unique: true })
export class ResourceAclEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'resource_type', length: 32 })
  resourceType!: 'document' | 'space' | 'folder';

  @Column('uuid', { name: 'resource_id' })
  resourceId!: string;

  @Column('varchar', { name: 'principal_type', length: 32 })
  principalType!: AccessPrincipalType;

  @Column('varchar', { name: 'principal_id', length: 128 })
  principalId!: string;

  @Column('varchar', { length: 128 })
  permission!: AccessPermissionKey;

  @Column('uuid', { name: 'created_by', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('document_effective_principal')
@Index(['tenantId', 'principalId'])
@Index(['tenantId', 'documentId', 'principalId', 'permission'], { unique: true })
export class DocumentEffectivePrincipalEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'document_id' })
  documentId!: string;

  @Column('varchar', { name: 'principal_id', length: 128 })
  principalId!: string;

  @Column('varchar', { length: 128 })
  permission!: 'documents.read';

  @Column('varchar', { name: 'source_resource_type', length: 32 })
  sourceResourceType!: 'document' | 'space' | 'folder';

  @Column('uuid', { name: 'source_resource_id' })
  sourceResourceId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('document')
@Index(['tenantId', 'createdAt'])
export class DocumentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'space_id', nullable: true })
  spaceId!: string | null;

  @Column('uuid', { name: 'folder_id', nullable: true })
  folderId!: string | null;

  @Column('varchar', { length: 500 })
  title!: string;

  @Column('text', { nullable: true })
  summary!: string | null;

  @Column('varchar', { length: 32, default: 'draft' })
  status!: DocumentStatus;

  @Column('uuid', { name: 'current_ready_version_id', nullable: true })
  currentReadyVersionId!: string | null;

  @Column('uuid', { name: 'created_by', nullable: true })
  createdBy!: string | null;

  @Column('uuid', { name: 'updated_by', nullable: true })
  updatedBy!: string | null;

  @Column('varchar', {
    name: 'access_principal_ids',
    length: 128,
    array: true,
    default: () => "'{}'",
  })
  accessPrincipalIds!: string[];

  @Column('integer', { name: 'acl_version', default: 1 })
  aclVersion!: number;

  @Column('integer', { name: 'search_projection_version', default: 1 })
  searchProjectionVersion!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column('timestamptz', { name: 'deleted_at', nullable: true })
  deletedAt!: Date | null;

  @Column('timestamptz', { name: 'purged_at', nullable: true })
  purgedAt!: Date | null;
}

@Entity('knowledge_space')
@Index(['tenantId', 'name'])
export class KnowledgeSpaceEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { length: 255 })
  name!: string;

  @Column('text', { nullable: true })
  description!: string | null;

  @Column('uuid', { name: 'created_by', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('knowledge_folder')
@Index(['tenantId', 'spaceId', 'parentId'])
export class KnowledgeFolderEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'space_id' })
  spaceId!: string;

  @Column('uuid', { name: 'parent_id', nullable: true })
  parentId!: string | null;

  @Column('varchar', { length: 255 })
  name!: string;

  @Column('text', { nullable: true })
  description!: string | null;

  @Column('integer', { name: 'sort_order', default: 0 })
  sortOrder!: number;

  @Column('uuid', { name: 'created_by', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('knowledge_tag')
@Index(['tenantId', 'name'])
export class KnowledgeTagEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { length: 80 })
  name!: string;

  @Column('char', { length: 7 })
  color!: string;

  @Column('text', { nullable: true })
  description!: string | null;

  @Column('uuid', { name: 'created_by', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('document_tag')
@Index(['tenantId', 'tagId'])
export class DocumentTagEntity {
  @PrimaryColumn('uuid', { name: 'document_id' })
  documentId!: string;

  @PrimaryColumn('uuid', { name: 'tag_id' })
  tagId!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('audit_event')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'resourceType', 'resourceId'])
export class AuditEventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'actor_id', nullable: true })
  actorId!: string | null;

  @Column('varchar', { length: 128 })
  action!: string;

  @Column('varchar', { name: 'resource_type', length: 64 })
  resourceType!: string;

  @Column('uuid', { name: 'resource_id', nullable: true })
  resourceId!: string | null;

  @Column('jsonb', { default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('search_query_event')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'resultCount', 'createdAt'])
export class SearchQueryEventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'user_id', nullable: true })
  userId!: string | null;

  @Column('varchar', { length: 16 })
  source!: SearchQuerySource;

  @Column('varchar', { name: 'query_text', length: 2_000 })
  queryText!: string;

  @Column('jsonb', { default: () => "'{}'::jsonb" })
  filters!: Record<string, unknown>;

  @Column('integer', { name: 'result_count', default: 0 })
  resultCount!: number;

  @Column('integer', { name: 'duration_ms', default: 0 })
  durationMs!: number;

  @Column('integer', { name: 'vector_candidate_count', default: 0 })
  vectorCandidateCount!: number;

  @Column('integer', { name: 'keyword_candidate_count', default: 0 })
  keywordCandidateCount!: number;

  @Column('varchar', { length: 16 })
  status!: 'success' | 'failed';

  @Column('varchar', { name: 'error_code', length: 128, nullable: true })
  errorCode!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('tenant_system_setting')
export class TenantSystemSettingEntity {
  @PrimaryColumn('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('integer', { name: 'search_candidate_limit', default: 200 })
  searchCandidateLimit!: number;

  @Column('double precision', { name: 'search_score_threshold', default: 0 })
  searchScoreThreshold!: number;

  @Column('integer', { name: 'search_page_size', default: 10 })
  searchPageSize!: number;

  @Column('boolean', { name: 'feedback_enabled', default: true })
  feedbackEnabled!: boolean;

  @Column('integer', { name: 'audit_retention_days', default: 365 })
  auditRetentionDays!: number;

  @Column('integer', { default: 1 })
  version!: number;

  @Column('uuid', { name: 'updated_by', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('search_feedback')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'queryEventId', 'userId'], { unique: true })
export class SearchFeedbackEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'query_event_id' })
  queryEventId!: string;

  @Column('uuid', { name: 'user_id' })
  userId!: string;

  @Column('varchar', { length: 16 })
  rating!: SearchFeedbackRating;

  @Column('varchar', { length: 32, nullable: true })
  reason!: SearchFeedbackReason | null;

  @Column('text', { nullable: true })
  comment!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('document_version')
@Index(['tenantId', 'documentId', 'versionNo'], { unique: true })
@Index(['tenantId', 'ingestionStatus'])
export class DocumentVersionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'document_id' })
  documentId!: string;

  @Column('integer', { name: 'version_no' })
  versionNo!: number;

  @Column('varchar', { name: 'source_bucket', length: 255 })
  sourceBucket!: string;

  @Column('text', { name: 'source_object_key' })
  sourceObjectKey!: string;

  @Column('varchar', { name: 'source_filename', length: 1024 })
  sourceFilename!: string;

  @Column('varchar', { name: 'mime_type', length: 255 })
  mimeType!: string;

  @Column('bigint', { name: 'size_bytes', transformer: numberFromBigint })
  sizeBytes!: number;

  @Column('char', { length: 64 })
  sha256!: string;

  @Column('varchar', { name: 'markdown_bucket', length: 255, nullable: true })
  markdownBucket!: string | null;

  @Column('text', { name: 'markdown_object_key', nullable: true })
  markdownObjectKey!: string | null;

  @Column('varchar', { name: 'parser_name', length: 128, nullable: true })
  parserName!: string | null;

  @Column('varchar', { name: 'parser_version', length: 64, nullable: true })
  parserVersion!: string | null;

  @Column('varchar', { name: 'ingestion_status', length: 32, default: 'received' })
  ingestionStatus!: IngestionStatus;

  @Column('integer', { name: 'word_count', default: 0 })
  wordCount!: number;

  @Column('varchar', { name: 'error_code', length: 128, nullable: true })
  errorCode!: string | null;

  @Column('text', { name: 'error_message', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column('timestamptz', { name: 'ready_at', nullable: true })
  readyAt!: Date | null;
}

@Entity('document_source_anchor')
@Index(['tenantId', 'documentVersionId'])
export class DocumentSourceAnchorEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'document_version_id' })
  documentVersionId!: string;

  @Column('varchar', { name: 'anchor_type', length: 32 })
  anchorType!: string;

  @Column('integer', { name: 'page_no', nullable: true })
  pageNo!: number | null;

  @Column('integer', { name: 'slide_no', nullable: true })
  slideNo!: number | null;

  @Column('varchar', { name: 'sheet_name', length: 255, nullable: true })
  sheetName!: string | null;

  @Column('integer', { name: 'row_start', nullable: true })
  rowStart!: number | null;

  @Column('integer', { name: 'row_end', nullable: true })
  rowEnd!: number | null;

  @Column('text', { nullable: true })
  heading!: string | null;

  @Column('integer', { name: 'markdown_offset_start' })
  markdownOffsetStart!: number;

  @Column('integer', { name: 'markdown_offset_end' })
  markdownOffsetEnd!: number;
}

@Entity('document_asset')
@Index(['tenantId', 'documentVersionId'])
@Index(['documentVersionId', 'objectKey'], { unique: true })
export class DocumentAssetEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'document_version_id' })
  documentVersionId!: string;

  @Column('varchar', { length: 32 })
  kind!: string;

  @Column('varchar', { length: 1024 })
  filename!: string;

  @Column('text', { name: 'object_key' })
  objectKey!: string;

  @Column('varchar', { name: 'mime_type', length: 255 })
  mimeType!: string;

  @Column('bigint', { name: 'size_bytes', transformer: numberFromBigint })
  sizeBytes!: number;

  @Column('char', { length: 64 })
  sha256!: string;

  @Column('integer', { name: 'page_no', nullable: true })
  pageNo!: number | null;

  @Column('integer')
  ordinal!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export const DOCUMENT_EMBEDDING_DIMENSIONS = 384;

@Entity('document_chunk')
@Index(['tenantId', 'documentVersionId'])
@Index(['documentVersionId', 'ordinal'], { unique: true })
export class DocumentChunkEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'document_id' })
  documentId!: string;

  @Column('uuid', { name: 'document_version_id' })
  documentVersionId!: string;

  @Column('integer')
  ordinal!: number;

  @Column('text')
  content!: string;

  @Column('char', { name: 'content_sha256', length: 64 })
  contentSha256!: string;

  @Column('integer', { name: 'token_count' })
  tokenCount!: number;

  @Column('varchar', { name: 'anchor_type', length: 32 })
  anchorType!: string;

  @Column('integer', { name: 'page_no', nullable: true })
  pageNo!: number | null;

  @Column('integer', { name: 'slide_no', nullable: true })
  slideNo!: number | null;

  @Column('varchar', { name: 'sheet_name', length: 255, nullable: true })
  sheetName!: string | null;

  @Column('integer', { name: 'row_start', nullable: true })
  rowStart!: number | null;

  @Column('integer', { name: 'row_end', nullable: true })
  rowEnd!: number | null;

  @Column('text', { nullable: true })
  heading!: string | null;

  @Column('integer', { name: 'markdown_offset_start' })
  markdownOffsetStart!: number;

  @Column('integer', { name: 'markdown_offset_end' })
  markdownOffsetEnd!: number;

  @Column('varchar', { name: 'principal_ids', length: 128, array: true })
  principalIds!: string[];

  @Column('vector', { length: DOCUMENT_EMBEDDING_DIMENSIONS })
  embedding!: number[];

  @Column('varchar', { name: 'embedding_model', length: 128 })
  embeddingModel!: string;

  @Column('varchar', { name: 'chunker_version', length: 64 })
  chunkerVersion!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('document_review_request')
@Index(['tenantId', 'status', 'submittedAt'])
@Index(['tenantId', 'documentId', 'submittedAt'])
export class DocumentReviewRequestEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'document_id' })
  documentId!: string;

  @Column('uuid', { name: 'document_version_id' })
  documentVersionId!: string;

  @Column('varchar', { length: 32, default: 'pending' })
  status!: DocumentReviewStatus;

  @Column('uuid', { name: 'submitted_by' })
  submittedBy!: string;

  @Column('timestamptz', { name: 'submitted_at', default: () => 'CURRENT_TIMESTAMP' })
  submittedAt!: Date;

  @Column('uuid', { name: 'resolved_by', nullable: true })
  resolvedBy!: string | null;

  @Column('timestamptz', { name: 'resolved_at', nullable: true })
  resolvedAt!: Date | null;

  @Column('text', { name: 'decision_comment', nullable: true })
  decisionComment!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity('document_review_action')
@Index(['reviewRequestId', 'createdAt'])
export class DocumentReviewActionEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'review_request_id' })
  reviewRequestId!: string;

  @Column('varchar', { length: 32 })
  action!: DocumentReviewAction;

  @Column('uuid', { name: 'actor_id' })
  actorId!: string;

  @Column('text', { nullable: true })
  comment!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('chat_conversation')
@Index(['tenantId', 'createdBy', 'updatedAt'])
export class ChatConversationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'created_by' })
  createdBy!: string;

  @Column('varchar', { length: 255 })
  title!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export type ChatMessageRole = 'user' | 'assistant';

@Entity('chat_message')
@Index(['tenantId', 'conversationId', 'createdAt'])
export class ChatMessageEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'conversation_id' })
  conversationId!: string;

  @Column('varchar', { length: 16 })
  role!: ChatMessageRole;

  @Column('text')
  content!: string;

  @Column('varchar', { length: 128, nullable: true })
  model!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity('chat_citation')
@Index(['tenantId', 'messageId'])
@Index(['tenantId', 'documentId'])
export class ChatCitationEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'message_id' })
  messageId!: string;

  @Column('integer')
  ordinal!: number;

  @Column('uuid', { name: 'chunk_id' })
  chunkId!: string;

  @Column('uuid', { name: 'document_id' })
  documentId!: string;

  @Column('uuid', { name: 'document_version_id' })
  documentVersionId!: string;

  @Column('varchar', { name: 'document_title', length: 500 })
  documentTitle!: string;

  @Column('text')
  excerpt!: string;

  @Column('jsonb')
  source!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type IngestionJobStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';

@Entity('ingestion_job')
@Index(['tenantId', 'createdAt'])
export class IngestionJobEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('uuid', { name: 'document_id' })
  documentId!: string;

  @Column('uuid', { name: 'document_version_id', unique: true })
  documentVersionId!: string;

  @Column('varchar', { length: 32, default: 'queued' })
  status!: IngestionJobStatus;

  @Column('integer', { default: 0 })
  progress!: number;

  @Column('integer', { default: 0 })
  attempts!: number;

  @Column('integer', { default: 1 })
  generation!: number;

  @Column('integer', { name: 'max_attempts', default: 3 })
  maxAttempts!: number;

  @Column('varchar', { name: 'queue_job_id', length: 255, nullable: true })
  queueJobId!: string | null;

  @Column('text', { name: 'error_message', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column('timestamptz', { name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  @Column('timestamptz', { name: 'cancellation_requested_at', nullable: true })
  cancellationRequestedAt!: Date | null;

  @Column('timestamptz', { name: 'dead_lettered_at', nullable: true })
  deadLetteredAt!: Date | null;
}

export type IngestionStageStatus = 'active' | 'completed' | 'failed' | 'skipped' | 'cancelled';

@Entity('ingestion_stage')
@Index(['jobId', 'stage'], { unique: true })
export class IngestionStageEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'job_id' })
  jobId!: string;

  @Column('varchar', { length: 32 })
  stage!: IngestionStatus;

  @Column('varchar', { length: 32 })
  status!: IngestionStageStatus;

  @Column('integer', { default: 0 })
  progress!: number;

  @Column('varchar', { name: 'processor_version', length: 64, nullable: true })
  processorVersion!: string | null;

  @Column('char', { name: 'input_checksum', length: 64, nullable: true })
  inputChecksum!: string | null;

  @Column('char', { name: 'output_checksum', length: 64, nullable: true })
  outputChecksum!: string | null;

  @Column('integer', { name: 'run_count', default: 0 })
  runCount!: number;

  @Column('text', { name: 'error_message', nullable: true })
  errorMessage!: string | null;

  @Column('timestamptz', { name: 'started_at', default: () => 'CURRENT_TIMESTAMP' })
  startedAt!: Date;

  @Column('timestamptz', { name: 'completed_at', nullable: true })
  completedAt!: Date | null;
}

export type OutboxEventStatus = 'pending' | 'processing' | 'published' | 'cancelled' | 'dead';

@Entity('outbox_event')
@Index(['status', 'nextAttemptAt'])
export class OutboxEventEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  tenantId!: string;

  @Column('varchar', { name: 'aggregate_type', length: 64 })
  aggregateType!: string;

  @Column('uuid', { name: 'aggregate_id' })
  aggregateId!: string;

  @Column('varchar', { name: 'event_type', length: 128 })
  eventType!: OutboxEventType;

  @Column('varchar', { name: 'deduplication_key', length: 255, unique: true })
  deduplicationKey!: string;

  @Column('jsonb')
  payload!: Record<string, unknown>;

  @Column('varchar', { length: 32, default: 'pending' })
  status!: OutboxEventStatus;

  @Column('integer', { default: 0 })
  attempts!: number;

  @Column('timestamptz', { name: 'next_attempt_at', default: () => 'CURRENT_TIMESTAMP' })
  nextAttemptAt!: Date;

  @Column('timestamptz', { name: 'locked_at', nullable: true })
  lockedAt!: Date | null;

  @Column('timestamptz', { name: 'published_at', nullable: true })
  publishedAt!: Date | null;

  @Column('text', { name: 'last_error', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export const databaseEntities = [
  TenantEntity,
  AppUserEntity,
  DepartmentEntity,
  DepartmentMemberEntity,
  AccessRoleEntity,
  AccessPermissionEntity,
  UserRoleEntity,
  RolePermissionEntity,
  ResourceAclEntity,
  DocumentEffectivePrincipalEntity,
  DocumentEntity,
  KnowledgeSpaceEntity,
  KnowledgeFolderEntity,
  KnowledgeTagEntity,
  DocumentTagEntity,
  AuditEventEntity,
  SearchQueryEventEntity,
  TenantSystemSettingEntity,
  SearchFeedbackEntity,
  DocumentVersionEntity,
  DocumentSourceAnchorEntity,
  DocumentAssetEntity,
  DocumentChunkEntity,
  DocumentReviewRequestEntity,
  DocumentReviewActionEntity,
  ChatConversationEntity,
  ChatMessageEntity,
  ChatCitationEntity,
  IngestionJobEntity,
  IngestionStageEntity,
  OutboxEventEntity,
] as const;
