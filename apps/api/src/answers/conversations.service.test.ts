import {
  AnswerRunEntity,
  ChatCitationEntity,
  ChatConversationEntity,
  ChatMessageEntity,
} from '@knowledge-base/database';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/auth-context';
import { ConversationsService } from './conversations.service';

const auth: AuthContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  principalIds: ['user:22222222-2222-4222-8222-222222222222'],
  permissionKeys: [],
  mode: 'demo',
};
const conversationId = '33333333-3333-4333-8333-333333333333';
const userMessageId = '44444444-4444-4444-8444-444444444444';
const assistantMessageId = '55555555-5555-4555-8555-555555555555';
const runId = '66666666-6666-4666-8666-666666666666';

describe('ConversationsService', () => {
  it('attaches the answer run to both messages in a completed exchange', async () => {
    const startedAt = new Date('2026-09-03T00:00:00.000Z');
    const completedAt = new Date('2026-09-03T00:00:01.000Z');
    const service = serviceWith({
      messages: [
        {
          id: userMessageId,
          tenantId: auth.tenantId,
          conversationId,
          role: 'user',
          content: 'Question',
          model: null,
          createdAt: startedAt,
        },
        {
          id: assistantMessageId,
          tenantId: auth.tenantId,
          conversationId,
          role: 'assistant',
          content: 'Answer',
          model: 'local-extractive-v1',
          createdAt: completedAt,
        },
      ],
      runs: [
        {
          id: runId,
          tenantId: auth.tenantId,
          conversationId,
          userMessageId,
          assistantMessageId,
          status: 'completed',
          errorCode: null,
          startedAt,
          completedAt,
        },
      ],
    });

    const result = await service.findOne(auth, conversationId);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.answerRun).toMatchObject({
      id: runId,
      status: 'completed',
      assistantMessageId,
    });
    expect(result.messages[1]?.answerRun).toMatchObject({
      id: runId,
      userMessageId,
    });
  });

  it('returns a failed run on an unanswered user message', async () => {
    const startedAt = new Date('2026-09-03T00:00:00.000Z');
    const completedAt = new Date('2026-09-03T00:00:01.000Z');
    const service = serviceWith({
      messages: [
        {
          id: userMessageId,
          tenantId: auth.tenantId,
          conversationId,
          role: 'user',
          content: 'Question',
          model: null,
          createdAt: startedAt,
        },
      ],
      runs: [
        {
          id: runId,
          tenantId: auth.tenantId,
          conversationId,
          userMessageId,
          assistantMessageId: null,
          status: 'failed',
          errorCode: 'model_timeout',
          startedAt,
          completedAt,
        },
      ],
    });

    const result = await service.findOne(auth, conversationId);

    expect(result.messages[0]?.answerRun).toMatchObject({
      status: 'failed',
      errorCode: 'model_timeout',
      assistantMessageId: null,
    });
  });
});

function serviceWith(input: {
  messages: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}) {
  const repositories = new Map<unknown, unknown>([
    [
      ChatConversationEntity,
      {
        findOne: vi.fn(async () => ({
          id: conversationId,
          tenantId: auth.tenantId,
          createdBy: auth.userId,
          title: 'Conversation',
          createdAt: new Date('2026-09-03T00:00:00.000Z'),
          updatedAt: new Date('2026-09-03T00:00:01.000Z'),
        })),
      },
    ],
    [ChatMessageEntity, { find: vi.fn(async () => input.messages) }],
    [AnswerRunEntity, { find: vi.fn(async () => input.runs) }],
    [ChatCitationEntity, { find: vi.fn(async () => []) }],
  ]);
  return new ConversationsService({
    getRepository: vi.fn((entity: unknown) => {
      const repository = repositories.get(entity);
      if (!repository) throw new Error(`Missing repository for ${String(entity)}`);
      return repository;
    }),
  } as never);
}
