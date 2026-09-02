import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApproveDocumentReviewRequestSchema,
  DocumentReviewQuerySchema,
  RejectDocumentReviewRequestSchema,
  SubmitDocumentReviewRequestSchema,
  WithdrawDocumentReviewRequestSchema,
  buildSuccess,
} from '@knowledge-base/contracts';
import type { AuthContext } from '../auth/auth-context';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { parseRequest } from '../common/validation';
import { DocumentReviewsService } from './document-reviews.service';

@Controller()
@UseGuards(AuthenticationGuard)
export class DocumentReviewsController {
  constructor(@Inject(DocumentReviewsService) private readonly reviews: DocumentReviewsService) {}

  @Post('documents/:documentId/versions/:versionId/reviews')
  async submit(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    const input = parseRequest(SubmitDocumentReviewRequestSchema, body);
    return buildSuccess(
      await this.reviews.submit(auth, documentId, versionId, input.comment ?? null),
    );
  }

  @Post('documents/:documentId/versions/:versionId/reviews/withdraw')
  async withdraw(
    @Param('documentId') documentId: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    const input = parseRequest(WithdrawDocumentReviewRequestSchema, body);
    return buildSuccess(
      await this.reviews.withdraw(auth, documentId, versionId, input.comment ?? null),
    );
  }

  @Get('documents/:documentId/reviews/history')
  async history(
    @Param('documentId') documentId: string,
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    const input = parseRequest(DocumentReviewQuerySchema, {
      ...(query as object),
      status: (query as { status?: unknown }).status ?? 'all',
    });
    return buildSuccess(await this.reviews.history(auth, documentId, input));
  }

  @Get('reviews/tasks')
  async tasks(@Query() query: unknown, @CurrentAuth() auth: AuthContext) {
    return buildSuccess(
      await this.reviews.tasks(auth, parseRequest(DocumentReviewQuerySchema, query)),
    );
  }

  @Post('reviews/tasks/:reviewId/approve')
  async approve(
    @Param('reviewId') reviewId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    const input = parseRequest(ApproveDocumentReviewRequestSchema, body);
    return buildSuccess(await this.reviews.approve(auth, reviewId, input.comment ?? null));
  }

  @Post('reviews/tasks/:reviewId/reject')
  async reject(
    @Param('reviewId') reviewId: string,
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ) {
    const input = parseRequest(RejectDocumentReviewRequestSchema, body);
    return buildSuccess(await this.reviews.reject(auth, reviewId, input.comment));
  }
}
