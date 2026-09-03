import { describe, expect, it } from 'vitest';
import { maximalMarginalRelevance, parseVectorLiteral } from './mmr';

describe('maximalMarginalRelevance', () => {
  const candidates = [
    { id: 'primary', relevanceScore: 1, embedding: [1, 0] },
    { id: 'duplicate', relevanceScore: 0.95, embedding: [0.99, 0.01] },
    { id: 'diverse', relevanceScore: 0.8, embedding: [0, 1] },
  ];

  it('keeps the strongest result first and then favors novel evidence', () => {
    expect(
      maximalMarginalRelevance(candidates, { lambda: 0.6 }).map((candidate) => candidate.id),
    ).toEqual(['primary', 'diverse', 'duplicate']);
  });

  it('reduces to relevance ordering when lambda is one', () => {
    expect(
      maximalMarginalRelevance(candidates, { lambda: 1 }).map((candidate) => candidate.id),
    ).toEqual(['primary', 'duplicate', 'diverse']);
  });

  it('supports bounded selection without mutating the input', () => {
    const original = [...candidates];

    expect(
      maximalMarginalRelevance(candidates, { lambda: 0.6, limit: 2 }).map(
        (candidate) => candidate.id,
      ),
    ).toEqual(['primary', 'diverse']);
    expect(candidates).toEqual(original);
  });
});

describe('parseVectorLiteral', () => {
  it('parses pgvector text and rejects malformed values', () => {
    expect(parseVectorLiteral('[0.25,-0.5,1]')).toEqual([0.25, -0.5, 1]);
    expect(parseVectorLiteral('[0.25,null]')).toEqual([]);
    expect(parseVectorLiteral('not-a-vector')).toEqual([]);
  });
});
