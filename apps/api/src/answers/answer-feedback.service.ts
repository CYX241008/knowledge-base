import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  SubmitAnswerFeedbackRequest,
  SubmitAnswerFeedbackResponse,
} from '@knowledge-base/contracts';
import {
  AnswerFeedbackEntity,
  AnswerRunEntity,
  ChatConversationEntity,
} from '@knowledge-base/database';
import { DataSource } from 'typeorm';
import { SystemGovernanceService } from '../system-governance/system-governance.service';
import type { AuthContext } from '../auth/auth-context';

@Injectable()
export class AnswerFeedbackService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(SystemGovernanceService)
    private readonly systemGovernance: SystemGovernanceService,
  ) {}

  async submit(
    auth: AuthContext,
    runId: string,
    input: SubmitAnswerFeedbackRequest,
  ): Promise<SubmitAnswerFeedbackResponse> {
    const settings = await this.systemGovernance.effectiveSettings(auth.tenantId);
    if (!settings.feedbackEnabled) {
      throw new ForbiddenException({
        code: 'ANSWER_FEEDBACK_DISABLED',
        message: 'Answer feedback is disabled for this tenant',
      });
    }

    const run = await this.dataSource.getRepository(AnswerRunEntity).findOneBy({
      id: runId,
      tenantId: auth.tenantId,
    });
    if (!run) throw new NotFoundException(`Answer run ${runId} not found`);
    const conversation = await this.dataSource.getRepository(ChatConversationEntity).findOneBy({
      id: run.conversationId,
      tenantId: auth.tenantId,
      createdBy: auth.userId,
    });
    if (!conversation) throw new NotFoundException(`Answer run ${runId} not found`);
    if (run.status !== 'completed' || !run.assistantMessageId) {
      throw new BadRequestException({
        code: 'ANSWER_FEEDBACK_NOT_AVAILABLE',
        message: 'Feedback can only be submitted for a completed answer',
      });
    }

    const repository = this.dataSource.getRepository(AnswerFeedbackEntity);
    const existing = await repository.findOneBy({
      tenantId: auth.tenantId,
      answerRunId: run.id,
      userId: auth.userId,
    });
    const feedback = await repository.save(
      repository.create({
        ...existing,
        id: existing?.id ?? randomUUID(),
        tenantId: auth.tenantId,
        answerRunId: run.id,
        userId: auth.userId,
        rating: input.rating,
        reason: input.rating === 'unhelpful' ? input.reason : null,
        comment: input.comment ?? null,
      }),
    );
    return {
      feedbackId: feedback.id,
      runId: feedback.answerRunId,
      rating: feedback.rating,
    };
  }
}
