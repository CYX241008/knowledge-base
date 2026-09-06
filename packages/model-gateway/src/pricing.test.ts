import { describe, expect, it } from 'vitest';
import { estimateModelCostUsd, parseModelPricingCatalog, resolveModelPrice } from './pricing';

describe('model pricing', () => {
  it('prefers exact operation and model prices', () => {
    const catalog = parseModelPricingCatalog(
      JSON.stringify({
        'chat:*': { input: 1, output: 2 },
        'chat:answer-model': { input: 3, output: 4 },
      }),
    );

    expect(
      resolveModelPrice(catalog, 'chat', 'answer-model', {
        inputCostPerMillionTokens: 0,
        outputCostPerMillionTokens: 0,
      }),
    ).toEqual({
      inputCostPerMillionTokens: 3,
      outputCostPerMillionTokens: 4,
      source: 'chat:answer-model',
    });
  });

  it('calculates input and output cost independently', () => {
    expect(
      estimateModelCostUsd(
        { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 },
        1_000,
        250,
      ),
    ).toBe(0.004);
  });
});
