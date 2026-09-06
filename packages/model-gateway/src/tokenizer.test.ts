import { describe, expect, it } from 'vitest';
import { countModelChatTokens, countModelTextTokens, truncateModelTextToTokens } from './tokenizer';

describe('model tokenizer', () => {
  it('uses a model encoding when the model is known', () => {
    expect(countModelTextTokens('gpt-4o-mini', 'hello world')).toBe(2);
  });

  it('falls back to the configured encoding for custom models', () => {
    const text = '知识库 token budget';
    expect(countModelTextTokens('custom-chat-model', text, 'cl100k_base')).toBe(
      countModelTextTokens('gpt-4', text, 'cl100k_base'),
    );
  });

  it('truncates text without exceeding the requested token budget', () => {
    const truncated = truncateModelTextToTokens(
      'gpt-4o-mini',
      '这是一个需要按照 token 数量截断的较长文本。',
      6,
    );

    expect(countModelTextTokens('gpt-4o-mini', truncated)).toBeLessThanOrEqual(6);
    expect(truncated.length).toBeGreaterThan(0);
  });

  it('includes chat message framing overhead', () => {
    const contentTokens = countModelTextTokens('gpt-4o-mini', 'hello');
    const chatTokens = countModelChatTokens('gpt-4o-mini', [{ role: 'user', content: 'hello' }]);

    expect(chatTokens).toBeGreaterThan(contentTokens);
  });
});
