import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from './search.service';

describe('reciprocalRankFusion', () => {
  it('rewards chunks returned by both retrievers', () => {
    const result = reciprocalRankFusion([
      [
        { id: 'vector-only', score: 0.9 },
        { id: 'shared', score: 0.8 },
      ],
      [
        { id: 'keyword-only', score: 10 },
        { id: 'shared', score: 8 },
      ],
    ]);

    expect(result[0]?.id).toBe('shared');
    expect(result).toHaveLength(3);
  });
});
