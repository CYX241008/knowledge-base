export type ModelPricingOperation = 'embedding' | 'chat' | 'rerank';

export type ModelPrice = {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
};

export type ResolvedModelPrice = ModelPrice & {
  source: string;
};

export type ModelPricingCatalog = Record<string, ModelPrice>;

export function parseModelPricingCatalog(value: string | undefined): ModelPricingCatalog {
  if (!value?.trim()) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MODEL_PRICING_JSON must be a JSON object');
  }
  const catalog: ModelPricingCatalog = {};
  for (const [key, price] of Object.entries(parsed)) {
    if (!price || typeof price !== 'object' || Array.isArray(price)) {
      throw new Error(`Invalid model price for ${key}`);
    }
    const input = Number(
      (price as Record<string, unknown>).inputCostPerMillionTokens ??
        (price as Record<string, unknown>).input,
    );
    const output = Number(
      (price as Record<string, unknown>).outputCostPerMillionTokens ??
        (price as Record<string, unknown>).output,
    );
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      throw new Error(`Invalid model price for ${key}`);
    }
    catalog[key] = {
      inputCostPerMillionTokens: input,
      outputCostPerMillionTokens: output,
    };
  }
  return catalog;
}

export function resolveModelPrice(
  catalog: ModelPricingCatalog,
  operation: ModelPricingOperation,
  model: string,
  fallback: ModelPrice,
): ResolvedModelPrice {
  if (model.startsWith('local-')) {
    return {
      inputCostPerMillionTokens: 0,
      outputCostPerMillionTokens: 0,
      source: 'local',
    };
  }
  for (const key of [`${operation}:${model}`, `${operation}:*`, `*:${model}`, '*:*']) {
    const price = catalog[key];
    if (price) return { ...price, source: key };
  }
  return { ...fallback, source: 'fallback' };
}

export function estimateModelCostUsd(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (Math.max(0, inputTokens) * price.inputCostPerMillionTokens +
      Math.max(0, outputTokens) * price.outputCostPerMillionTokens) /
    1_000_000
  );
}
