import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import { TenantSystemSettingEntity } from '@knowledge-base/database';
import { logEvent } from '@knowledge-base/observability';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ModelPricingService } from './model-pricing.service';

@Injectable()
export class ModelBudgetService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(ModelPricingService) private readonly pricing: ModelPricingService,
  ) {}

  async assertEmbeddingAllowed(
    tenantId: string,
    model: string,
    inputTokens: number,
  ): Promise<void> {
    const settings = await this.dataSource
      .getRepository(TenantSystemSettingEntity)
      .findOneBy({ tenantId });
    const dailyBudget = settings?.modelDailyBudgetUsd ?? 0;
    const monthlyBudget = settings?.modelMonthlyBudgetUsd ?? 0;
    const action = settings?.modelBudgetAction ?? 'warn';
    const estimatedCost =
      this.pricing.estimate('embedding', model, inputTokens, 0) *
      (this.config.getOrThrow('MODEL_MAX_RETRIES') + 1);
    const maxCallCost = this.config.getOrThrow('MODEL_MAX_CALL_COST_USD');
    if (estimatedCost === 0 || (dailyBudget === 0 && monthlyBudget === 0 && maxCallCost === 0)) {
      return;
    }
    const { dayStart, monthStart } = periodStarts(
      new Date(),
      this.config.getOrThrow('MODEL_BUDGET_TIMEZONE_OFFSET_MINUTES'),
    );
    const [usage] = await this.dataSource.query<Array<{ dailyCost: string; monthlyCost: string }>>(
      `SELECT COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= $2), 0) AS "dailyCost",
              COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= $3), 0) AS "monthlyCost"
       FROM model_usage_event
       WHERE tenant_id = $1`,
      [tenantId, dayStart, monthStart],
    );
    const dailyUsed = Number(usage?.dailyCost ?? 0);
    const monthlyUsed = Number(usage?.monthlyCost ?? 0);
    await Promise.all([
      this.emitAlerts(tenantId, 'day', dayStart, dailyUsed, dailyBudget),
      this.emitAlerts(tenantId, 'month', monthStart, monthlyUsed, monthlyBudget),
    ]);
    const exceeded =
      (maxCallCost > 0 && estimatedCost > maxCallCost) ||
      (dailyBudget > 0 && dailyUsed + estimatedCost > dailyBudget) ||
      (monthlyBudget > 0 && monthlyUsed + estimatedCost > monthlyBudget);
    if (!exceeded || action === 'warn') return;
    logEvent('model.embedding_budget_blocked', {
      tenantId,
      model,
      inputTokens,
      estimatedCost,
      action,
    });
    throw new ModelBudgetExceededError('Embedding budget exceeded');
  }

  async recordThresholds(tenantId: string, now = new Date()): Promise<void> {
    const settings = await this.dataSource
      .getRepository(TenantSystemSettingEntity)
      .findOneBy({ tenantId });
    const dailyBudget = settings?.modelDailyBudgetUsd ?? 0;
    const monthlyBudget = settings?.modelMonthlyBudgetUsd ?? 0;
    if (dailyBudget === 0 && monthlyBudget === 0) return;
    const { dayStart, monthStart } = periodStarts(
      now,
      this.config.getOrThrow('MODEL_BUDGET_TIMEZONE_OFFSET_MINUTES'),
    );
    const [usage] = await this.dataSource.query<Array<{ dailyCost: string; monthlyCost: string }>>(
      `SELECT COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= $2), 0) AS "dailyCost",
              COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= $3), 0) AS "monthlyCost"
       FROM model_usage_event
       WHERE tenant_id = $1`,
      [tenantId, dayStart, monthStart],
    );
    await Promise.all([
      this.emitAlerts(tenantId, 'day', dayStart, Number(usage?.dailyCost ?? 0), dailyBudget),
      this.emitAlerts(
        tenantId,
        'month',
        monthStart,
        Number(usage?.monthlyCost ?? 0),
        monthlyBudget,
      ),
    ]);
  }

  private async emitAlerts(
    tenantId: string,
    periodType: 'day' | 'month',
    periodStart: Date,
    usageCostUsd: number,
    budgetUsd: number,
  ): Promise<void> {
    if (budgetUsd <= 0) return;
    for (const thresholdPercent of thresholds(
      this.config.getOrThrow('MODEL_BUDGET_ALERT_THRESHOLDS'),
    )) {
      if ((usageCostUsd / budgetUsd) * 100 < thresholdPercent) continue;
      await this.dataSource.query(
        `INSERT INTO model_budget_alert (
           id, tenant_id, period_type, period_start, threshold_percent, usage_cost_usd, budget_usd
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, period_type, period_start, threshold_percent) DO NOTHING`,
        [
          randomUUID(),
          tenantId,
          periodType,
          periodStart,
          thresholdPercent,
          usageCostUsd,
          budgetUsd,
        ],
      );
    }
  }
}

export class ModelBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelBudgetExceededError';
  }
}

function periodStarts(now: Date, offsetMinutes: number) {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  return {
    dayStart: new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
        offsetMinutes * 60_000,
    ),
    monthStart: new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - offsetMinutes * 60_000,
    ),
  };
}

function thresholds(value: string): number[] {
  return [...new Set(value.split(',').map(Number))]
    .filter((item) => Number.isFinite(item) && item > 0 && item <= 100)
    .sort((left, right) => left - right);
}
