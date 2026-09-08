import { ChatCitationEntity } from '@knowledge-base/database';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/auth-context';
import { SystemGovernanceService } from './system-governance.service';

const auth: AuthContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  principalIds: ['user:22222222-2222-4222-8222-222222222222'],
  permissionKeys: ['knowledge.manage'],
  mode: 'demo',
};

describe('SystemGovernanceService evaluation candidates', () => {
  it('exports unhelpful answers with their actual citations for human annotation', async () => {
    const assistantMessageId = '33333333-3333-4333-8333-333333333333';
    const assertGovernanceRead = vi.fn();
    const service = new SystemGovernanceService(
      {
        query: vi.fn(async () => [
          {
            feedbackId: '44444444-4444-4444-8444-444444444444',
            runId: '55555555-5555-4555-8555-555555555555',
            question: '退款规则是什么？',
            observedAnswer: '退款需要在七天内申请。[1]',
            model: 'answer-model',
            degraded: false,
            degradationReason: null,
            reason: 'citation_incorrect',
            comment: '引用没有包含未拆封条件',
            assistantMessageId,
            createdAt: new Date('2026-09-08T00:00:00.000Z'),
          },
        ]),
        getRepository: vi.fn((entity: unknown) => {
          if (entity !== ChatCitationEntity) {
            throw new Error(`Unexpected repository ${String(entity)}`);
          }
          return {
            find: vi.fn(async () => [
              {
                messageId: assistantMessageId,
                ordinal: 1,
                chunkId: '66666666-6666-4666-8666-666666666666',
                documentId: '77777777-7777-4777-8777-777777777777',
                documentVersionId: '88888888-8888-4888-8888-888888888888',
                documentTitle: '售后规则',
                excerpt: '退货需在七天内申请，且商品未拆封。',
                source: {
                  type: 'heading',
                  page: null,
                  slide: null,
                  sheet: null,
                  rowStart: null,
                  rowEnd: null,
                  heading: '退货',
                  offsetStart: 0,
                  offsetEnd: 20,
                },
              },
            ]),
          };
        }),
      } as never,
      {} as never,
      { assertGovernanceRead } as never,
      {} as never,
      {} as never,
    );

    const result = await service.evaluationCandidates(auth, { days: 30, limit: 100 });

    expect(assertGovernanceRead).toHaveBeenCalledWith(auth);
    expect(result).toMatchObject({
      annotationRequired: true,
      items: [
        {
          question: '退款规则是什么？',
          observedGrounded: true,
          reason: 'citation_incorrect',
          citations: [{ ordinal: 1, title: '售后规则' }],
        },
      ],
    });
    expect(result.items[0]).not.toHaveProperty('userId');
    expect(result.items[0]).not.toHaveProperty('tenantId');
  });
});
