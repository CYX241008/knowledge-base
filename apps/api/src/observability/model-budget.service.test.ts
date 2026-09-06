import type { ServerEnv } from '@knowledge-base/config';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { ModelBudgetService } from './model-budget.service';

describe('ModelBudgetService', () => {
  it('returns degrade and records crossed thresholds', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM model_usage_event')) {
        return [{ dailyCost: '8', monthlyCost: '16' }];
      }
      return [{ id: 'alert' }];
    });
    const service = new ModelBudgetService(
      {
        getRepository: vi.fn(() => ({
          findOneBy: vi.fn(async () => ({
            modelDailyBudgetUsd: 10,
            modelMonthlyBudgetUsd: 20,
            modelBudgetAction: 'degrade',
          })),
        })),
        query,
      } as never,
      {
        getOrThrow: vi.fn((key: keyof ServerEnv) => {
          const values: Partial<Record<keyof ServerEnv, unknown>> = {
            MODEL_BUDGET_TIMEZONE_OFFSET_MINUTES: 0,
            MODEL_BUDGET_ALERT_THRESHOLDS: '70,90,100',
            MODEL_MAX_CALL_COST_USD: 0,
            MODEL_MAX_RETRIES: 0,
          };
          return values[key];
        }),
      } as unknown as ConfigService<ServerEnv, true>,
      { estimate: vi.fn(() => 3) } as never,
    );

    const assessment = await service.assess({
      tenantId: '11111111-1111-4111-8111-111111111111',
      operation: 'chat',
      model: 'answer-model',
      inputTokens: 1_000,
      maxOutputTokens: 500,
      now: new Date('2026-09-06T10:00:00.000Z'),
    });

    expect(assessment).toMatchObject({
      mode: 'degrade',
      reason: 'daily_budget',
      estimatedCostUsd: 3,
      daily: { usedUsd: 8, projectedUsd: 11, budgetUsd: 10, ratio: 1.1 },
    });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO'))).toHaveLength(2);
  });
});
