import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import {
  ModelBudgetAlertEntity,
  TenantSystemSettingEntity,
  type ModelUsageOperation,
} from '@knowledge-base/database';
import { logEvent } from '@knowledge-base/observability';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ModelPricingService } from './model-pricing.service';

export type ModelBudgetAction = 'warn' | 'degrade' | 'reject';

export type ModelBudgetAssessment = {
  mode: 'allow' | 'degrade' | 'reject';
  reason: 'within_budget' | 'single_call' | 'daily_budget' | 'monthly_budget';
  action: ModelBudgetAction;
  estimatedCostUsd: number;
  daily: { usedUsd: number; projectedUsd: number; budgetUsd: number; ratio: number };
  monthly: { usedUsd: number; projectedUsd: number; budgetUsd: number; ratio: number };
};

@Injectable()
export class ModelBudgetService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(ModelPricingService) private readonly pricing: ModelPricingService,
  ) {}

  async assess(input: {
    tenantId: string;
    operation: ModelUsageOperation;
    model: string;
    inputTokens: number;
    maxOutputTokens: number;
    now?: Date;
  }): Promise<ModelBudgetAssessment> {
    const now = input.now ?? new Date();
    const settings = await this.dataSource
      .getRepository(TenantSystemSettingEntity)
      .findOneBy({ tenantId: input.tenantId });
    const dailyBudgetUsd = settings?.modelDailyBudgetUsd ?? 0;
    const monthlyBudgetUsd = settings?.modelMonthlyBudgetUsd ?? 0;
    const action = settings?.modelBudgetAction ?? 'warn';
    const estimatedCostUsd =
      this.pricing.estimate(
        input.operation,
        input.model,
        input.inputTokens,
        input.maxOutputTokens,
      ) *
      (this.config.getOrThrow('MODEL_MAX_RETRIES') + 1);
    const maxCallCost = this.config.getOrThrow('MODEL_MAX_CALL_COST_USD');
    if (
      estimatedCostUsd === 0 ||
      (dailyBudgetUsd === 0 && monthlyBudgetUsd === 0 && maxCallCost === 0)
    ) {
      return {
        mode: 'allow',
        reason: 'within_budget',
        action,
        estimatedCostUsd: 0,
        daily: budgetWindow(0, 0, 0),
        monthly: budgetWindow(0, 0, 0),
      };
    }
    const { dayStart, monthStart } = budgetPeriodStarts(
      now,
      this.config.getOrThrow('MODEL_BUDGET_TIMEZONE_OFFSET_MINUTES'),
    );
    const [usage] = await this.dataSource.query<Array<{ dailyCost: string; monthlyCost: string }>>(
      `SELECT COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= $2), 0) AS "dailyCost",
              COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= $3), 0) AS "monthlyCost"
       FROM model_usage_event
       WHERE tenant_id = $1`,
      [input.tenantId, dayStart, monthStart],
    );
    const dailyUsedUsd = Number(usage?.dailyCost ?? 0);
    const monthlyUsedUsd = Number(usage?.monthlyCost ?? 0);
    const assessment: ModelBudgetAssessment = {
      mode: 'allow',
      reason: 'within_budget',
      action,
      estimatedCostUsd,
      daily: budgetWindow(dailyUsedUsd, estimatedCostUsd, dailyBudgetUsd),
      monthly: budgetWindow(monthlyUsedUsd, estimatedCostUsd, monthlyBudgetUsd),
    };
    await Promise.all([
      this.emitAlerts(
        input.tenantId,
        'day',
        dayStart,
        budgetWindow(dailyUsedUsd, 0, dailyBudgetUsd),
      ),
      this.emitAlerts(
        input.tenantId,
        'month',
        monthStart,
        budgetWindow(monthlyUsedUsd, 0, monthlyBudgetUsd),
      ),
    ]);

    if (maxCallCost > 0 && estimatedCostUsd > maxCallCost) {
      assessment.reason = 'single_call';
    } else if (dailyBudgetUsd > 0 && assessment.daily.projectedUsd > dailyBudgetUsd) {
      assessment.reason = 'daily_budget';
    } else if (monthlyBudgetUsd > 0 && assessment.monthly.projectedUsd > monthlyBudgetUsd) {
      assessment.reason = 'monthly_budget';
    } else {
      return assessment;
    }
    assessment.mode = action === 'warn' ? 'allow' : action;
    return assessment;
  }

  async status(tenantId: string): Promise<{
    assessment: ModelBudgetAssessment;
    alerts: ModelBudgetAlertEntity[];
  }> {
    const settings = await this.dataSource
      .getRepository(TenantSystemSettingEntity)
      .findOneBy({ tenantId });
    const action = settings?.modelBudgetAction ?? 'warn';
    const dailyBudgetUsd = settings?.modelDailyBudgetUsd ?? 0;
    const monthlyBudgetUsd = settings?.modelMonthlyBudgetUsd ?? 0;
    const { dayStart, monthStart } = budgetPeriodStarts(
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
    const assessment: ModelBudgetAssessment = {
      mode: 'allow',
      reason: 'within_budget',
      action,
      estimatedCostUsd: 0,
      daily: budgetWindow(Number(usage?.dailyCost ?? 0), 0, dailyBudgetUsd),
      monthly: budgetWindow(Number(usage?.monthlyCost ?? 0), 0, monthlyBudgetUsd),
    };
    const alerts = await this.dataSource.getRepository(ModelBudgetAlertEntity).find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    return { assessment, alerts };
  }

  async recordThresholds(tenantId: string, now = new Date()): Promise<void> {
    const settings = await this.dataSource
      .getRepository(TenantSystemSettingEntity)
      .findOneBy({ tenantId });
    const dailyBudgetUsd = settings?.modelDailyBudgetUsd ?? 0;
    const monthlyBudgetUsd = settings?.modelMonthlyBudgetUsd ?? 0;
    if (dailyBudgetUsd === 0 && monthlyBudgetUsd === 0) return;
    const { dayStart, monthStart } = budgetPeriodStarts(
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
      this.emitAlerts(
        tenantId,
        'day',
        dayStart,
        budgetWindow(Number(usage?.dailyCost ?? 0), 0, dailyBudgetUsd),
      ),
      this.emitAlerts(
        tenantId,
        'month',
        monthStart,
        budgetWindow(Number(usage?.monthlyCost ?? 0), 0, monthlyBudgetUsd),
      ),
    ]);
  }

  private async emitAlerts(
    tenantId: string,
    periodType: 'day' | 'month',
    periodStart: Date,
    window: ModelBudgetAssessment['daily'],
  ): Promise<void> {
    if (window.budgetUsd <= 0) return;
    for (const thresholdPercent of budgetThresholds(
      this.config.getOrThrow('MODEL_BUDGET_ALERT_THRESHOLDS'),
    )) {
      if (window.ratio * 100 < thresholdPercent) continue;
      const result = await this.dataSource.query(
        `INSERT INTO model_budget_alert (
           id, tenant_id, period_type, period_start, threshold_percent, usage_cost_usd, budget_usd
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, period_type, period_start, threshold_percent) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          tenantId,
          periodType,
          periodStart,
          thresholdPercent,
          window.projectedUsd,
          window.budgetUsd,
        ],
      );
      if (Array.isArray(result) && result.length > 0) {
        logEvent('model.budget_threshold_reached', {
          tenantId,
          periodType,
          thresholdPercent,
          usageCostUsd: window.projectedUsd,
          budgetUsd: window.budgetUsd,
        });
      }
    }
  }
}

export class ModelBudgetExceededError extends HttpException {
  constructor(readonly assessment: ModelBudgetAssessment) {
    super(
      {
        code: 'MODEL_BUDGET_EXCEEDED',
        message: `Model budget exceeded: ${assessment.reason}`,
        budget: assessment,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
    this.name = 'ModelBudgetExceededError';
  }
}

function budgetWindow(usedUsd: number, plannedUsd: number, budgetUsd: number) {
  const projectedUsd = usedUsd + plannedUsd;
  return {
    usedUsd,
    projectedUsd,
    budgetUsd,
    ratio: budgetUsd > 0 ? projectedUsd / budgetUsd : 0,
  };
}

function budgetPeriodStarts(
  now: Date,
  offsetMinutes: number,
): {
  dayStart: Date;
  monthStart: Date;
} {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const dayStartShifted = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  const monthStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  return {
    dayStart: new Date(dayStartShifted - offsetMinutes * 60_000),
    monthStart: new Date(monthStartShifted - offsetMinutes * 60_000),
  };
}

function budgetThresholds(value: string): number[] {
  return [...new Set(value.split(',').map(Number))]
    .filter((item) => Number.isFinite(item) && item > 0 && item <= 100)
    .sort((left, right) => left - right);
}
