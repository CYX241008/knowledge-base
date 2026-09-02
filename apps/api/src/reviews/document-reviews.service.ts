import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DocumentReviewAction,
  DocumentReviewItem,
  DocumentReviewListResponse,
  DocumentReviewQuery,
} from '@knowledge-base/contracts';
import {
  AppUserEntity,
  DocumentEntity,
  DocumentReviewActionEntity,
  DocumentReviewRequestEntity,
  DocumentVersionEntity,
} from '@knowledge-base/database';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { AccessControlService } from '../access-control/access-control.service';
import type { AuthContext } from '../auth/auth-context';
import { IngestionService } from '../ingestion/ingestion.service';

@Injectable()
export class DocumentReviewsService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
    @Inject(IngestionService) private readonly ingestionService: IngestionService,
  ) {}

  async submit(
    auth: AuthContext,
    documentId: string,
    versionId: string,
    comment: string | null,
  ): Promise<DocumentReviewItem> {
    await this.accessControl.assertDocumentManage(auth, documentId);
    let reviewId: string;
    try {
      reviewId = await this.dataSource.transaction(async (manager) => {
        const document = await manager.getRepository(DocumentEntity).findOne({
          where: { id: documentId, tenantId: auth.tenantId, deletedAt: IsNull() },
          lock: { mode: 'pessimistic_write' },
        });
        if (!document) throw new NotFoundException(`Document ${documentId} not found`);
        if (document.status === 'archived') {
          throw new BadRequestException({
            code: 'ARCHIVED_DOCUMENT_REVIEW',
            message: 'Archived documents cannot be submitted for review',
          });
        }
        const version = await manager.getRepository(DocumentVersionEntity).findOne({
          where: { id: versionId, documentId, tenantId: auth.tenantId },
          lock: { mode: 'pessimistic_read' },
        });
        if (!version) throw new NotFoundException(`Document version ${versionId} not found`);
        if (version.ingestionStatus !== 'ready') {
          throw new BadRequestException({
            code: 'DOCUMENT_VERSION_NOT_READY',
            message: 'Only a ready document version can be submitted for review',
          });
        }
        if (document.status === 'published' && document.currentReadyVersionId === version.id) {
          throw new BadRequestException({
            code: 'DOCUMENT_VERSION_ALREADY_PUBLISHED',
            message: 'The current published version does not require review',
          });
        }
        const pending = await manager.getRepository(DocumentReviewRequestEntity).findOne({
          where: { tenantId: auth.tenantId, documentId, status: 'pending' },
          lock: { mode: 'pessimistic_write' },
        });
        if (pending) {
          throw new ConflictException({
            code: 'DOCUMENT_REVIEW_ALREADY_PENDING',
            message: 'This document already has a pending review request',
          });
        }

        const id = randomUUID();
        const submittedAt = new Date();
        await manager.getRepository(DocumentReviewRequestEntity).save({
          id,
          tenantId: auth.tenantId,
          documentId,
          documentVersionId: versionId,
          status: 'pending',
          submittedBy: auth.userId,
          submittedAt,
          resolvedBy: null,
          resolvedAt: null,
          decisionComment: null,
        });
        await this.saveAction(manager, auth, id, 'submitted', comment);
        await this.accessControl.recordAudit(
          manager,
          auth,
          'document.review.submitted',
          'document',
          documentId,
          { reviewId: id, documentVersionId: versionId, versionNo: version.versionNo, comment },
        );
        return id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'DOCUMENT_REVIEW_ALREADY_PENDING',
          message: 'This document already has a pending review request',
        });
      }
      throw error;
    }
    return this.findReview(auth.tenantId, reviewId);
  }

  async withdraw(
    auth: AuthContext,
    documentId: string,
    versionId: string,
    comment: string | null,
  ): Promise<DocumentReviewItem> {
    await this.accessControl.assertDocumentManage(auth, documentId);
    const reviewId = await this.dataSource.transaction(async (manager) => {
      const review = await manager.getRepository(DocumentReviewRequestEntity).findOne({
        where: {
          tenantId: auth.tenantId,
          documentId,
          documentVersionId: versionId,
          status: 'pending',
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!review) {
        throw new NotFoundException('No pending review request was found for this version');
      }
      await this.resolveRequest(manager, review, auth, 'withdrawn', 'withdrawn', comment);
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.review.withdrawn',
        'document',
        documentId,
        { reviewId: review.id, documentVersionId: versionId, comment },
      );
      return review.id;
    });
    return this.findReview(auth.tenantId, reviewId);
  }

  async approve(
    auth: AuthContext,
    reviewId: string,
    comment: string | null,
  ): Promise<DocumentReviewItem> {
    this.accessControl.assertDocumentReview(auth);
    await this.dataSource.transaction(async (manager) => {
      const review = await this.pendingReview(manager, auth.tenantId, reviewId);
      const version = await manager.getRepository(DocumentVersionEntity).findOne({
        where: {
          id: review.documentVersionId,
          documentId: review.documentId,
          tenantId: auth.tenantId,
        },
        lock: { mode: 'pessimistic_read' },
      });
      if (!version)
        throw new NotFoundException(`Document version ${review.documentVersionId} not found`);
      if (version.ingestionStatus !== 'ready') {
        throw new BadRequestException({
          code: 'DOCUMENT_VERSION_NOT_READY',
          message: 'Only a ready document version can be approved',
        });
      }
      const document = await manager.getRepository(DocumentEntity).findOne({
        where: { id: review.documentId, tenantId: auth.tenantId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!document) throw new NotFoundException(`Document ${review.documentId} not found`);
      if (document.status === 'archived') {
        throw new BadRequestException({
          code: 'ARCHIVED_DOCUMENT_REVIEW',
          message: 'Archived documents cannot be approved',
        });
      }

      const previousVersionId = document.currentReadyVersionId;
      await this.resolveRequest(manager, review, auth, 'approved', 'approved', comment);
      document.currentReadyVersionId = version.id;
      document.status = 'published';
      document.updatedBy = auth.userId;
      await this.ingestionService.createSearchProjectionIntent(
        manager,
        document,
        'review-approved',
      );
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.review.approved',
        'document',
        document.id,
        {
          reviewId,
          documentVersionId: version.id,
          versionNo: version.versionNo,
          previousDocumentVersionId: previousVersionId,
          comment,
        },
      );
    });
    this.ingestionService.dispatchPending();
    return this.findReview(auth.tenantId, reviewId);
  }

  async reject(auth: AuthContext, reviewId: string, comment: string): Promise<DocumentReviewItem> {
    this.accessControl.assertDocumentReview(auth);
    await this.dataSource.transaction(async (manager) => {
      const review = await this.pendingReview(manager, auth.tenantId, reviewId);
      await this.resolveRequest(manager, review, auth, 'rejected', 'rejected', comment);
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.review.rejected',
        'document',
        review.documentId,
        { reviewId, documentVersionId: review.documentVersionId, comment },
      );
    });
    return this.findReview(auth.tenantId, reviewId);
  }

  async tasks(auth: AuthContext, query: DocumentReviewQuery): Promise<DocumentReviewListResponse> {
    this.accessControl.assertDocumentReview(auth);
    return this.list(auth.tenantId, query);
  }

  async history(
    auth: AuthContext,
    documentId: string,
    query: DocumentReviewQuery,
  ): Promise<DocumentReviewListResponse> {
    await this.accessControl.assertDocumentManage(auth, documentId);
    return this.list(auth.tenantId, query, documentId);
  }

  private async list(
    tenantId: string,
    query: DocumentReviewQuery,
    documentId?: string,
  ): Promise<DocumentReviewListResponse> {
    const qb = this.dataSource
      .getRepository(DocumentReviewRequestEntity)
      .createQueryBuilder('review')
      .where('review.tenantId = :tenantId', { tenantId });
    if (documentId) qb.andWhere('review.documentId = :documentId', { documentId });
    if (query.status !== 'all') qb.andWhere('review.status = :status', { status: query.status });
    qb.orderBy('review.submittedAt', 'DESC')
      .addOrderBy('review.id', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize);
    const [reviews, total] = await qb.getManyAndCount();
    return {
      items: await this.hydrate(reviews),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async findReview(tenantId: string, reviewId: string): Promise<DocumentReviewItem> {
    const review = await this.dataSource
      .getRepository(DocumentReviewRequestEntity)
      .findOneBy({ id: reviewId, tenantId });
    if (!review) throw new NotFoundException(`Document review ${reviewId} not found`);
    const [item] = await this.hydrate([review]);
    if (!item) throw new NotFoundException(`Document review ${reviewId} not found`);
    return item;
  }

  private async hydrate(reviews: DocumentReviewRequestEntity[]): Promise<DocumentReviewItem[]> {
    if (reviews.length === 0) return [];
    const documentIds = [...new Set(reviews.map((review) => review.documentId))];
    const versionIds = [...new Set(reviews.map((review) => review.documentVersionId))];
    const requestIds = reviews.map((review) => review.id);
    const actorIds = [
      ...new Set(
        reviews.flatMap((review) => [
          review.submittedBy,
          ...(review.resolvedBy ? [review.resolvedBy] : []),
        ]),
      ),
    ];
    const [documents, versions, actions, actors] = await Promise.all([
      this.dataSource.getRepository(DocumentEntity).findBy({ id: In(documentIds) }),
      this.dataSource.getRepository(DocumentVersionEntity).findBy({ id: In(versionIds) }),
      this.dataSource.getRepository(DocumentReviewActionEntity).find({
        where: { reviewRequestId: In(requestIds) },
        order: { createdAt: 'ASC', id: 'ASC' },
      }),
      this.dataSource.getRepository(AppUserEntity).findBy({ id: In(actorIds) }),
    ]);
    const documentById = new Map(documents.map((document) => [document.id, document]));
    const versionById = new Map(versions.map((version) => [version.id, version]));
    const actorById = new Map(actors.map((actor) => [actor.id, actor]));
    const actionsByRequest = new Map<string, DocumentReviewActionEntity[]>();
    for (const action of actions) {
      const current = actionsByRequest.get(action.reviewRequestId) ?? [];
      current.push(action);
      actionsByRequest.set(action.reviewRequestId, current);
    }
    return reviews.map((review) => {
      const document = documentById.get(review.documentId);
      const version = versionById.get(review.documentVersionId);
      if (!document || !version) {
        throw new Error(`Document review ${review.id} references missing data`);
      }
      return {
        id: review.id,
        documentId: review.documentId,
        documentVersionId: review.documentVersionId,
        documentTitle: document.title,
        versionNo: version.versionNo,
        sourceFilename: version.sourceFilename,
        status: review.status,
        submittedBy: review.submittedBy,
        submittedByName: actorById.get(review.submittedBy)?.displayName ?? null,
        submittedAt: review.submittedAt.toISOString(),
        resolvedBy: review.resolvedBy,
        resolvedByName: review.resolvedBy
          ? (actorById.get(review.resolvedBy)?.displayName ?? null)
          : null,
        resolvedAt: review.resolvedAt?.toISOString() ?? null,
        decisionComment: review.decisionComment,
        actions: (actionsByRequest.get(review.id) ?? []).map((action) => ({
          id: action.id,
          action: action.action,
          actorId: action.actorId,
          actorName: actorById.get(action.actorId)?.displayName ?? null,
          comment: action.comment,
          createdAt: action.createdAt.toISOString(),
        })),
      };
    });
  }

  private async pendingReview(
    manager: EntityManager,
    tenantId: string,
    reviewId: string,
  ): Promise<DocumentReviewRequestEntity> {
    const review = await manager.getRepository(DocumentReviewRequestEntity).findOne({
      where: { id: reviewId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!review) throw new NotFoundException(`Document review ${reviewId} not found`);
    if (review.status !== 'pending') {
      throw new ConflictException({
        code: 'DOCUMENT_REVIEW_ALREADY_RESOLVED',
        message: 'This document review has already been resolved',
      });
    }
    return review;
  }

  private async resolveRequest(
    manager: EntityManager,
    review: DocumentReviewRequestEntity,
    auth: AuthContext,
    status: 'approved' | 'rejected' | 'withdrawn',
    action: DocumentReviewAction,
    comment: string | null,
  ): Promise<void> {
    review.status = status;
    review.resolvedBy = auth.userId;
    review.resolvedAt = new Date();
    review.decisionComment = comment;
    await manager.getRepository(DocumentReviewRequestEntity).save(review);
    await this.saveAction(manager, auth, review.id, action, comment);
  }

  private async saveAction(
    manager: EntityManager,
    auth: AuthContext,
    reviewRequestId: string,
    action: DocumentReviewAction,
    comment: string | null,
  ): Promise<void> {
    await manager.getRepository(DocumentReviewActionEntity).save({
      id: randomUUID(),
      tenantId: auth.tenantId,
      reviewRequestId,
      action,
      actorId: auth.userId,
      comment,
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
