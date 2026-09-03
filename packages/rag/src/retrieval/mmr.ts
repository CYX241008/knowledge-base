export type MmrCandidate = {
  id: string;
  relevanceScore: number;
  embedding: readonly number[];
};

export type MmrOptions = {
  lambda?: number;
  limit?: number;
};

export function maximalMarginalRelevance<T extends MmrCandidate>(
  candidates: readonly T[],
  options: MmrOptions = {},
): T[] {
  const lambda = options.lambda ?? 0.7;
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    throw new RangeError('MMR lambda must be between 0 and 1');
  }
  const limit = Math.min(
    candidates.length,
    Math.max(0, Math.trunc(options.limit ?? candidates.length)),
  );
  if (limit === 0) return [];

  const normalizedEmbeddings = candidates.map((candidate) => normalizeVector(candidate.embedding));
  const maximumRedundancy = candidates.map(() => 0);
  const selectedIndices: number[] = [];
  const remainingIndices = new Set(candidates.map((_, index) => index));

  while (selectedIndices.length < limit) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidateIndex of remainingIndices) {
      const relevance = clamp(candidates[candidateIndex]?.relevanceScore ?? 0, 0, 1);
      const score = lambda * relevance - (1 - lambda) * (maximumRedundancy[candidateIndex] ?? 0);
      if (score > bestScore) {
        bestIndex = candidateIndex;
        bestScore = score;
      }
    }
    if (bestIndex < 0) break;
    selectedIndices.push(bestIndex);
    remainingIndices.delete(bestIndex);
    for (const candidateIndex of remainingIndices) {
      maximumRedundancy[candidateIndex] = Math.max(
        maximumRedundancy[candidateIndex] ?? 0,
        cosineSimilarity(normalizedEmbeddings[candidateIndex], normalizedEmbeddings[bestIndex]),
      );
    }
  }

  return selectedIndices.map((index) => candidates[index] as T);
}

export function parseVectorLiteral(value: string | readonly number[]): number[] {
  if (typeof value !== 'string') {
    return value.every(Number.isFinite) ? [...value] : [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === 'number' && Number.isFinite(item))
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function normalizeVector(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) return [];
  return vector.map((component) => component / magnitude);
}

function cosineSimilarity(
  left: readonly number[] | undefined,
  right: readonly number[] | undefined,
): number {
  if (!left?.length || left.length !== right?.length) return 0;
  const similarity = left.reduce(
    (sum, component, index) => sum + component * (right[index] ?? 0),
    0,
  );
  return clamp(similarity, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
