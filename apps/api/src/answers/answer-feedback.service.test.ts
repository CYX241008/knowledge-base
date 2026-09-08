import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  AnswerFeedbackEntity,
  AnswerRunEntity,
  ChatConversationEntity,
} from '@knowledge-base/database';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/auth-context';
import { AnswerFeedbackService } from './answer-feedback.service';

const auth: AuthContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  principalIds: ['user:22222222-2222-4222-8222-222222222222'],
  permissionKeys: [],
  mode: 'demo',
};
const runId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';
const assistantMessageId = '55555555-5555-4555-8555-555555555555';

describe('AnswerFeedbackService', () => {
  it('upserts feedback for the owner of a completed answer', async () => {
    const saved: Array<Record<string, unknown>> = [];
    const feedbackRepository = {
      findOneBy: vi.fn(async () => null),
      create: vi.fn((value) => value),
      save: vi.fn(async (value) => {
        saved.push(value);
        return value;
      }),
    };
    const service = serviceWith(feedbackRepository);

    const result = await service.submit(auth, runId, {
      rating: 'unhelpful',
      reason: 'citation_incorrect',
      comment: 'The citation does not support the claim',
    });

    expect(result).toMatchObject({ runId, rating: 'unhelpful' });
    expect(saved[0]).toMatchObject({
      tenantId: auth.tenantId,
      answerRunId: runId,
      userId: auth.userId,
      rating: 'unhelpful',
      reason: 'citation_incorrect',
    });
  });

  it('does not expose answer runs owned by another user', async () => {
    const service = serviceWith(
      {
        findOneBy: vi.fn(async () => null),
        create: vi.fn(),
        save: vi.fn(),
      },
      null,
    );

    await expect(
      service.submit(auth, runId, {
        rating: 'helpful',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('respects the tenant feedback setting', async () => {
    const service = serviceWith(
      {
        findOneBy: vi.fn(),
        create: vi.fn(),
        save: vi.fn(),
      },
      { id: conversationId },
      false,
    );

    await expect(
      service.submit(auth, runId, {
        rating: 'helpful',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

function serviceWith(
  feedbackRepository: Record<string, unknown>,
  conversation: Record<string, unknown> | null = {
    id: conversationId,
    tenantId: auth.tenantId,
    createdBy: auth.userId,
  },
  feedbackEnabled = true,
) {
  const repositories = new Map<unknown, Record<string, unknown>>([
    [
      AnswerRunEntity,
      {
        findOneBy: vi.fn(async () => ({
          id: runId,
          tenantId: auth.tenantId,
          conversationId,
          assistantMessageId,
          status: 'completed',
        })),
      },
    ],
    [ChatConversationEntity, { findOneBy: vi.fn(async () => conversation) }],
    [AnswerFeedbackEntity, feedbackRepository],
  ]);
  return new AnswerFeedbackService(
    {
      getRepository: vi.fn((entity: unknown) => {
        const repository = repositories.get(entity);
        if (!repository) throw new Error(`Missing repository for ${String(entity)}`);
        return repository;
      }),
    } as never,
    {
      effectiveSettings: vi.fn(async () => ({ feedbackEnabled })),
    } as never,
  );
}
