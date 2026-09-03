import type { SearchDocumentHit } from '@knowledge-base/contracts';
import { describe, expect, it } from 'vitest';
import {
  consolidateSearchCandidates,
  type ConsolidationCandidate,
} from './candidate-consolidation';

describe('consolidateSearchCandidates', () => {
  it('removes exact duplicates by hash and keeps the higher-scoring source', () => {
    const result = consolidateSearchCandidates(
      [
        candidate({
          id: 'lower',
          score: 0.7,
          hash: 'same-hash',
          documentVersionId: 'version-2',
        }),
        candidate({
          id: 'higher',
          score: 0.9,
          hash: 'same-hash',
          documentVersionId: 'version-1',
        }),
      ],
      0.92,
    );

    expect(result.candidates.map((item) => item.hit.chunkId)).toEqual(['higher']);
    expect(result.stats.exactDuplicatesRemoved).toBe(1);
  });

  it('merges highly similar adjacent chunks from the same source', () => {
    const result = consolidateSearchCandidates(
      [
        candidate({
          id: 'first',
          ordinal: 1,
          content: 'abcdefghij',
          offsetStart: 0,
          offsetEnd: 10,
          embedding: [1, 0],
        }),
        candidate({
          id: 'second',
          ordinal: 2,
          content: 'ijKLMN',
          offsetStart: 8,
          offsetEnd: 14,
          embedding: [0.99, 0.01],
        }),
      ],
      0.92,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.hit.content).toBe('abcdefghijKLMN');
    expect(result.candidates[0]?.hit.source).toMatchObject({ offsetStart: 0, offsetEnd: 14 });
    expect(result.stats.adjacentChunksMerged).toBe(1);
  });

  it('drops a lower-scoring non-adjacent near duplicate from the same source', () => {
    const result = consolidateSearchCandidates(
      [
        candidate({ id: 'higher', ordinal: 1, score: 0.9, embedding: [1, 0] }),
        candidate({ id: 'lower', ordinal: 4, score: 0.7, embedding: [0.99, 0.01] }),
      ],
      0.92,
    );

    expect(result.candidates.map((item) => item.hit.chunkId)).toEqual(['higher']);
    expect(result.stats.nonAdjacentDuplicatesRemoved).toBe(1);
  });

  it('preserves similar candidates when their sources differ', () => {
    const result = consolidateSearchCandidates(
      [
        candidate({
          id: 'source-a',
          ordinal: 1,
          score: 0.9,
          embedding: [1, 0],
          heading: 'Policy A',
        }),
        candidate({
          id: 'source-b',
          ordinal: 4,
          score: 0.7,
          embedding: [0.99, 0.01],
          heading: 'Policy B',
        }),
      ],
      0.92,
    );

    expect(result.candidates.map((item) => item.hit.chunkId)).toEqual(['source-a', 'source-b']);
    expect(result.stats.crossSourceSimilarPreserved).toBe(1);
  });
});

function candidate({
  id,
  ordinal = 1,
  score = 0.8,
  hash = `${id}-hash`,
  content = id,
  offsetStart = 0,
  offsetEnd = content.length,
  embedding = [1, 0],
  documentVersionId = 'version-1',
  heading = 'Policy',
}: {
  id: string;
  ordinal?: number;
  score?: number;
  hash?: string;
  content?: string;
  offsetStart?: number;
  offsetEnd?: number;
  embedding?: number[];
  documentVersionId?: string;
  heading?: string;
}): ConsolidationCandidate {
  const hit: SearchDocumentHit = {
    chunkId: id,
    documentId: `document-${documentVersionId}`,
    documentVersionId,
    title: 'Candidate',
    content,
    score,
    source: {
      type: 'heading',
      page: null,
      slide: null,
      sheet: null,
      rowStart: null,
      rowEnd: null,
      heading,
      offsetStart,
      offsetEnd,
    },
  };
  return {
    hit,
    ordinalStart: ordinal,
    ordinalEnd: ordinal,
    contentSha256: hash,
    embedding,
  };
}
