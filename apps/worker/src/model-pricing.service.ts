import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import {
  estimateModelCostUsd,
  parseModelPricingCatalog,
  resolveModelPrice,
  type ModelPricingOperation,
  type ResolvedModelPrice,
} from '@knowledge-base/model-gateway';

@Injectable()
export class ModelPricingService {
  private readonly catalog;

  constructor(@Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>) {
    this.catalog = parseModelPricingCatalog(config.getOrThrow('MODEL_PRICING_JSON'));
  }

  resolve(operation: ModelPricingOperation, model: string): ResolvedModelPrice {
    return resolveModelPrice(this.catalog, operation, model, {
      inputCostPerMillionTokens: this.config.getOrThrow('MODEL_INPUT_COST_PER_MILLION_TOKENS'),
      outputCostPerMillionTokens: this.config.getOrThrow('MODEL_OUTPUT_COST_PER_MILLION_TOKENS'),
    });
  }

  estimate(
    operation: ModelPricingOperation,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): number {
    return estimateModelCostUsd(this.resolve(operation, model), inputTokens, outputTokens);
  }
}
