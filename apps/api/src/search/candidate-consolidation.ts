import type { SearchDocumentHit } from '@knowledge-base/contracts';

export type ConsolidationCandidate = {
  hit: SearchDocumentHit;
  ordinalStart: number;
  ordinalEnd: number;
  contentSha256: string;
  embedding: number[];
};

export type CandidateConsolidationStats = {
  exactDuplicatesRemoved: number;
  adjacentChunksMerged: number;
  nonAdjacentDuplicatesRemoved: number;
  crossSourceSimilarPreserved: number;
};

export type CandidateConsolidationResult = {
  candidates: ConsolidationCandidate[];
  stats: CandidateConsolidationStats;
};

export function consolidateSearchCandidates(
  candidates: readonly ConsolidationCandidate[],
  similarityThreshold: number,
): CandidateConsolidationResult {
  if (!Number.isFinite(similarityThreshold) || similarityThreshold < 0 || similarityThreshold > 1) {
    throw new RangeError('Near-duplicate similarity threshold must be between 0 and 1');
  }

  const stats: CandidateConsolidationStats = {
    exactDuplicatesRemoved: 0,
    adjacentChunksMerged: 0,
    nonAdjacentDuplicatesRemoved: 0,
    crossSourceSimilarPreserved: 0,
  };
  const inputIndex = new Map(candidates.map((candidate, index) => [candidate.hit.chunkId, index]));
  const ranked = [...candidates].sort(
    (left, right) =>
      right.hit.score - left.hit.score ||
      (inputIndex.get(left.hit.chunkId) ?? 0) - (inputIndex.get(right.hit.chunkId) ?? 0),
  );
  const exactUnique = removeExactDuplicates(ranked, stats);
  const merged = mergeAdjacentCandidates(exactUnique, similarityThreshold, stats);
  const retained = removeNonAdjacentDuplicates(merged, similarityThreshold, stats);
  return { candidates: retained, stats };
}

function removeExactDuplicates(
  candidates: readonly ConsolidationCandidate[],
  stats: CandidateConsolidationStats,
): ConsolidationCandidate[] {
  const seenHashes = new Set<string>();
  return candidates.filter((candidate) => {
    const hash = candidate.contentSha256.trim();
    if (!hash || !seenHashes.has(hash)) {
      if (hash) seenHashes.add(hash);
      return true;
    }
    stats.exactDuplicatesRemoved += 1;
    return false;
  });
}

function mergeAdjacentCandidates(
  candidates: readonly ConsolidationCandidate[],
  similarityThreshold: number,
  stats: CandidateConsolidationStats,
): ConsolidationCandidate[] {
  const inputIndex = new Map(candidates.map((candidate, index) => [candidate.hit.chunkId, index]));
  const groupsBySource = new Map<string, ConsolidationCandidate[]>();
  for (const candidate of candidates) {
    const key = sourceIdentity(candidate);
    const group = groupsBySource.get(key) ?? [];
    group.push(candidate);
    groupsBySource.set(key, group);
  }

  const merged: ConsolidationCandidate[] = [];
  for (const sourceCandidates of groupsBySource.values()) {
    const ordered = [...sourceCandidates].sort(
      (left, right) => left.ordinalStart - right.ordinalStart,
    );
    let group: ConsolidationCandidate[] = [];
    for (const candidate of ordered) {
      const previous = group.at(-1);
      if (
        previous &&
        previous.ordinalEnd + 1 === candidate.ordinalStart &&
        cosineSimilarity(previous.embedding, candidate.embedding) >= similarityThreshold
      ) {
        group.push(candidate);
        continue;
      }
      if (group.length > 0) merged.push(mergeCandidateGroup(group, inputIndex, stats));
      group = [candidate];
    }
    if (group.length > 0) merged.push(mergeCandidateGroup(group, inputIndex, stats));
  }

  return merged.sort(
    (left, right) =>
      (inputIndex.get(left.hit.chunkId) ?? Number.MAX_SAFE_INTEGER) -
      (inputIndex.get(right.hit.chunkId) ?? Number.MAX_SAFE_INTEGER),
  );
}

function mergeCandidateGroup(
  candidates: ConsolidationCandidate[],
  inputIndex: Map<string, number>,
  stats: CandidateConsolidationStats,
): ConsolidationCandidate {
  if (candidates.length === 1) return candidates[0] as ConsolidationCandidate;
  stats.adjacentChunksMerged += candidates.length - 1;
  const representative = [...candidates].sort(
    (left, right) =>
      right.hit.score - left.hit.score ||
      (inputIndex.get(left.hit.chunkId) ?? 0) - (inputIndex.get(right.hit.chunkId) ?? 0),
  )[0] as ConsolidationCandidate;
  const ordered = [...candidates].sort((left, right) => left.ordinalStart - right.ordinalStart);
  const first = ordered[0] as ConsolidationCandidate;
  const last = ordered.at(-1) as ConsolidationCandidate;
  return {
    ...representative,
    ordinalStart: first.ordinalStart,
    ordinalEnd: last.ordinalEnd,
    contentSha256: ordered.map((candidate) => candidate.contentSha256.trim()).join(':'),
    embedding: averageEmbeddings(ordered),
    hit: {
      ...representative.hit,
      content: mergeContents(ordered),
      source: {
        ...representative.hit.source,
        offsetStart: Math.min(...ordered.map((candidate) => candidate.hit.source.offsetStart)),
        offsetEnd: Math.max(...ordered.map((candidate) => candidate.hit.source.offsetEnd)),
      },
    },
  };
}

function removeNonAdjacentDuplicates(
  candidates: readonly ConsolidationCandidate[],
  similarityThreshold: number,
  stats: CandidateConsolidationStats,
): ConsolidationCandidate[] {
  const retained: ConsolidationCandidate[] = [];
  for (const candidate of candidates) {
    let duplicate = false;
    let crossSourceMatch = false;
    for (const existing of retained) {
      if (cosineSimilarity(candidate.embedding, existing.embedding) < similarityThreshold) continue;
      if (sourceIdentity(candidate) !== sourceIdentity(existing)) {
        crossSourceMatch = true;
        continue;
      }
      if (!areAdjacent(candidate, existing)) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      stats.nonAdjacentDuplicatesRemoved += 1;
      continue;
    }
    if (crossSourceMatch) stats.crossSourceSimilarPreserved += 1;
    retained.push(candidate);
  }
  return retained;
}

function mergeContents(candidates: ConsolidationCandidate[]): string {
  const first = candidates[0];
  if (!first) return '';
  let content = first.hit.content;
  let offsetEnd = first.hit.source.offsetEnd;
  for (const candidate of candidates.slice(1)) {
    const overlap = Math.max(0, offsetEnd - candidate.hit.source.offsetStart);
    if (overlap < candidate.hit.content.length) {
      content +=
        overlap > 0
          ? candidate.hit.content.slice(overlap)
          : `${content.endsWith('\n') ? '' : '\n\n'}${candidate.hit.content}`;
    }
    offsetEnd = Math.max(offsetEnd, candidate.hit.source.offsetEnd);
  }
  return content;
}

function averageEmbeddings(candidates: ConsolidationCandidate[]): number[] {
  const dimensions = candidates[0]?.embedding.length ?? 0;
  if (
    dimensions === 0 ||
    candidates.some((candidate) => candidate.embedding.length !== dimensions)
  ) {
    return candidates[0]?.embedding ?? [];
  }
  const average = Array.from({ length: dimensions }, () => 0);
  let totalWeight = 0;
  for (const candidate of candidates) {
    const weight = Math.max(1, candidate.hit.content.length);
    totalWeight += weight;
    candidate.embedding.forEach((component, index) => {
      average[index] = (average[index] ?? 0) + component * weight;
    });
  }
  return average.map((component) => component / totalWeight);
}

function sourceIdentity(candidate: ConsolidationCandidate): string {
  return JSON.stringify([
    candidate.hit.documentVersionId,
    candidate.hit.source.type,
    candidate.hit.source.page,
    candidate.hit.source.slide,
    candidate.hit.source.sheet,
    candidate.hit.source.rowStart,
    candidate.hit.source.rowEnd,
    candidate.hit.source.heading,
  ]);
}

function areAdjacent(left: ConsolidationCandidate, right: ConsolidationCandidate): boolean {
  return (
    left.hit.documentVersionId === right.hit.documentVersionId &&
    (left.ordinalEnd + 1 === right.ordinalStart || right.ordinalEnd + 1 === left.ordinalStart)
  );
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dotProduct = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index] ?? 0;
    const rightComponent = right[index] ?? 0;
    dotProduct += leftComponent * rightComponent;
    leftMagnitude += leftComponent * leftComponent;
    rightMagnitude += rightComponent * rightComponent;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(0, Math.min(1, dotProduct / Math.sqrt(leftMagnitude * rightMagnitude)));
}
