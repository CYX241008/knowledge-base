import { describe, expect, it } from 'vitest';
import { planRetrievalQuery } from './query-planning';

describe('planRetrievalQuery', () => {
  it('rewrites polite factual questions and reduces answer evidence K', () => {
    const plan = planRetrievalQuery('请问怎么申请退款？', {
      baseCandidateLimit: 200,
      requestedResultLimit: 8,
      source: 'answer',
    });

    expect(plan.intent).toBe('fact');
    expect(plan.variants.map((variant) => variant.text)).toContain('如何申请退款');
    expect(plan.resultLimit).toBe(5);
    expect(plan.candidateLimit).toBe(200);
  });

  it('extracts exact identifiers and favors keyword retrieval', () => {
    const plan = planRetrievalQuery('查看 parser-sample.pdf 的处理结果', {
      baseCandidateLimit: 200,
      requestedResultLimit: 6,
      source: 'answer',
    });

    expect(plan.intent).toBe('exact');
    expect(plan.variants).toContainEqual(
      expect.objectContaining({ text: 'parser-sample.pdf', kind: 'exact', useVector: false }),
    );
    expect(plan.keywordWeight).toBeGreaterThan(plan.vectorWeight);
    expect(plan.candidateLimit).toBe(120);
    expect(plan.resultLimit).toBe(3);
  });

  it('decomposes comparison questions and expands the candidate window', () => {
    const plan = planRetrievalQuery('比较产品 X 和产品 Y 的区别', {
      baseCandidateLimit: 200,
      requestedResultLimit: 8,
      source: 'answer',
    });

    expect(plan.intent).toBe('comparison');
    expect(plan.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: '产品 X', kind: 'subquery' }),
        expect.objectContaining({ text: '产品 Y', kind: 'subquery' }),
      ]),
    );
    expect(plan.candidateLimit).toBe(300);
    expect(plan.resultLimit).toBe(8);
  });

  it('keeps direct-search pagination limits unchanged', () => {
    const plan = planRetrievalQuery('分析去年营收下降的原因和影响', {
      baseCandidateLimit: 200,
      requestedResultLimit: 10,
      source: 'search',
    });

    expect(plan.intent).toBe('analysis');
    expect(plan.candidateLimit).toBe(350);
    expect(plan.resultLimit).toBe(10);
  });

  it('can be disabled without changing the configured limits', () => {
    const plan = planRetrievalQuery('比较产品 X 和产品 Y 的区别', {
      baseCandidateLimit: 200,
      requestedResultLimit: 8,
      source: 'answer',
      enabled: false,
    });

    expect(plan).toMatchObject({
      enabled: false,
      candidateLimit: 200,
      resultLimit: 8,
      keywordWeight: 1,
      vectorWeight: 1,
    });
    expect(plan.variants).toHaveLength(1);
  });
});
