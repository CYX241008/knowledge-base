export type RagEvaluationCategory =
  'chinese' | 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'no-answer' | 'prompt-injection';

export type RagEvaluationSourceMatcher = {
  type?: 'document' | 'heading' | 'page' | 'slide' | 'sheet';
  page?: number;
  slide?: number;
  sheet?: string;
  heading?: string;
};

export type RagEvaluationRelevantChunk = {
  documentTitle: string;
  source?: RagEvaluationSourceMatcher;
  contentIncludes?: string[];
  relevance?: number;
};

export type RagEvaluationCase = {
  id: string;
  category: RagEvaluationCategory;
  question: string;
  expectedGrounded: boolean;
  requiredAnswerTerms?: string[];
  forbiddenAnswerTerms?: string[];
  expectedDocumentTitles?: string[];
  expectedSourceTypes?: Array<'document' | 'heading' | 'page' | 'slide' | 'sheet'>;
  relevantChunks?: RagEvaluationRelevantChunk[];
};

export type RagEvaluationSource = {
  type: string;
  page?: number | null;
  slide?: number | null;
  sheet?: string | null;
  heading?: string | null;
};

export type RagEvaluationRetrievedChunk = {
  chunkId?: string;
  title: string;
  content: string;
  score: number;
  source: RagEvaluationSource;
};

export const RAG_EVALUATION_STAGES = [
  'vector',
  'keyword',
  'rrf',
  'reranked',
  'consolidated',
  'selected',
] as const;
export type RagEvaluationStage = (typeof RAG_EVALUATION_STAGES)[number];

export type RagEvaluationRetrievalDiagnostics = {
  candidateLimit: number;
  scoreThreshold: number;
  mmrLambda: number;
  nearDuplicateThreshold: number;
  consolidation: {
    exactDuplicatesRemoved: number;
    adjacentChunksMerged: number;
    nonAdjacentDuplicatesRemoved: number;
    crossSourceSimilarPreserved: number;
  };
  timingsMs: {
    settings: number;
    embedding: number;
    vector: number;
    keyword: number;
    fusion: number;
    hydration: number;
    rerank: number;
    consolidation: number;
    mmr: number;
    total: number;
  };
  stages: Record<
    RagEvaluationStage,
    {
      candidateCount: number;
      hits: RagEvaluationRetrievedChunk[];
    }
  >;
};

export type RagEvaluationObservation = {
  grounded: boolean;
  answer: string;
  citations: Array<{
    chunkId?: string;
    title: string;
    excerpt?: string;
    source: RagEvaluationSource;
  }>;
  latencyMs: number;
  estimatedCostUsd?: number;
  retrievalDiagnostics?: RagEvaluationRetrievalDiagnostics;
};

export type RagMetricConfidenceInterval = {
  lower: number;
  upper: number;
};

export type RagDistributionSummary = {
  samples: number;
  total: number;
  mean: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  meanConfidenceInterval95: RagMetricConfidenceInterval;
  p50ConfidenceInterval95: RagMetricConfidenceInterval;
  p95ConfidenceInterval95: RagMetricConfidenceInterval;
  p99ConfidenceInterval95: RagMetricConfidenceInterval;
};

export type RagEvaluationStageCaseResult = {
  candidateCount: number;
  relevantRanks: Array<number | null>;
  recallAtK: Record<string, number>;
  ndcgAtK: Record<string, number>;
};

export type RagEvaluationCaseResult = {
  id: string;
  category: RagEvaluationCategory;
  iteration: number;
  passed: boolean;
  groundedCorrect: boolean;
  matchedAnswerTerms: number;
  requiredAnswerTerms: number;
  matchedDocuments: number;
  expectedDocuments: number;
  matchedSourceTypes: number;
  expectedSourceTypes: number;
  relevantCitations: number;
  citationCount: number;
  matchedRelevantChunks: number;
  expectedRelevantChunks: number;
  injectionSafe: boolean;
  latencyMs: number;
  estimatedCostUsd: number;
  retrieval?: {
    candidateLimit: number;
    scoreThreshold: number;
    mmrLambda: number;
    nearDuplicateThreshold: number;
    consolidation: RagEvaluationRetrievalDiagnostics['consolidation'];
    timingsMs: RagEvaluationRetrievalDiagnostics['timingsMs'];
    stages: Record<RagEvaluationStage, RagEvaluationStageCaseResult>;
  };
};

export type RagEvaluationStageSummary = {
  evaluatedCases: number;
  averageCandidateCount: number;
  recallAtK: Record<string, number>;
  recallAtKConfidence95: Record<string, RagMetricConfidenceInterval>;
  ndcgAtK: Record<string, number>;
  ndcgAtKConfidence95: Record<string, RagMetricConfidenceInterval>;
};

export type RagEvaluationReport = {
  datasetCaseCount: number;
  repetitions: number;
  caseCount: number;
  passedCases: number;
  passRate: number;
  groundedAccuracy: number;
  answerTermRecall: number;
  citationRecall: number;
  citationPrecision: number;
  citationChunkRecall: number;
  sourceAccuracy: number;
  injectionSafety: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  latency: RagDistributionSummary;
  costUsd: RagDistributionSummary;
  confidenceIntervals95: {
    passRate: RagMetricConfidenceInterval;
    groundedAccuracy: RagMetricConfidenceInterval;
    citationPrecision: RagMetricConfidenceInterval;
    citationChunkRecall: RagMetricConfidenceInterval;
  };
  retrieval: {
    cutoffs: number[];
    stages: Record<RagEvaluationStage, RagEvaluationStageSummary>;
    timingsMs: Record<keyof RagEvaluationRetrievalDiagnostics['timingsMs'], RagDistributionSummary>;
  };
  cases: RagEvaluationCaseResult[];
};

export type RagEvaluationOptions = {
  repetitions?: number;
  cutoffs?: number[];
  bootstrapSamples?: number;
};

export async function evaluateRag(
  cases: RagEvaluationCase[],
  run: (evaluationCase: RagEvaluationCase, iteration: number) => Promise<RagEvaluationObservation>,
  options: RagEvaluationOptions = {},
): Promise<RagEvaluationReport> {
  const repetitions = positiveInteger(options.repetitions ?? 1, 'repetitions');
  const cutoffs = normalizeCutoffs(options.cutoffs ?? [1, 3, 5, 8, 10, 20, 50]);
  const bootstrapSamples = positiveInteger(options.bootstrapSamples ?? 1_000, 'bootstrapSamples');
  const results: RagEvaluationCaseResult[] = [];

  for (let iteration = 1; iteration <= repetitions; iteration += 1) {
    for (const evaluationCase of cases) {
      const observation = await run(evaluationCase, iteration);
      results.push(evaluateCase(evaluationCase, observation, iteration, cutoffs));
    }
  }

  const sum = (select: (result: RagEvaluationCaseResult) => number) =>
    results.reduce((total, result) => total + select(result), 0);
  const totalRequiredTerms = sum((result) => result.requiredAnswerTerms);
  const totalExpectedDocuments = sum((result) => result.expectedDocuments);
  const totalExpectedSourceTypes = sum((result) => result.expectedSourceTypes);
  const totalCitations = sum((result) => result.citationCount);
  const relevantCitations = sum((result) => result.relevantCitations);
  const totalExpectedRelevantChunks = sum((result) => result.expectedRelevantChunks);
  const matchedRelevantChunks = sum((result) => result.matchedRelevantChunks);
  const injectionCases = results.filter((result) => result.category === 'prompt-injection');
  const latencies = results.map((result) => result.latencyMs);
  const costs = results.map((result) => result.estimatedCostUsd);
  const passedCases = results.filter((result) => result.passed).length;
  const groundedCorrect = results.filter((result) => result.groundedCorrect).length;
  const passRate = ratio(passedCases, results.length);
  const groundedAccuracy = ratio(groundedCorrect, results.length);
  const citationPrecision = ratio(relevantCitations, totalCitations);
  const citationChunkRecall = ratio(matchedRelevantChunks, totalExpectedRelevantChunks);
  const latency = summarizeDistribution(latencies, bootstrapSamples, 17, 2);
  const costUsd = summarizeDistribution(costs, bootstrapSamples, 29, 8);

  return {
    datasetCaseCount: cases.length,
    repetitions,
    caseCount: results.length,
    passedCases,
    passRate,
    groundedAccuracy,
    answerTermRecall: ratio(
      sum((result) => result.matchedAnswerTerms),
      totalRequiredTerms,
    ),
    citationRecall: ratio(
      sum((result) => result.matchedDocuments),
      totalExpectedDocuments,
    ),
    citationPrecision,
    citationChunkRecall,
    sourceAccuracy: ratio(
      sum((result) => result.matchedSourceTypes),
      totalExpectedSourceTypes,
    ),
    injectionSafety: ratio(
      injectionCases.filter((result) => result.injectionSafe).length,
      injectionCases.length,
    ),
    p50LatencyMs: latency.p50,
    p95LatencyMs: latency.p95,
    p99LatencyMs: latency.p99,
    latency,
    costUsd,
    confidenceIntervals95: {
      passRate: wilsonInterval(passedCases, results.length),
      groundedAccuracy: wilsonInterval(groundedCorrect, results.length),
      citationPrecision: wilsonInterval(relevantCitations, totalCitations),
      citationChunkRecall: wilsonInterval(matchedRelevantChunks, totalExpectedRelevantChunks),
    },
    retrieval: summarizeRetrieval(results, cutoffs, bootstrapSamples),
    cases: results,
  };
}

function evaluateCase(
  evaluationCase: RagEvaluationCase,
  observation: RagEvaluationObservation,
  iteration: number,
  cutoffs: number[],
): RagEvaluationCaseResult {
  const requiredTerms = evaluationCase.requiredAnswerTerms ?? [];
  const expectedDocuments = evaluationCase.expectedDocumentTitles ?? [];
  const expectedSourceTypes = evaluationCase.expectedSourceTypes ?? [];
  const forbiddenTerms = evaluationCase.forbiddenAnswerTerms ?? [];
  const relevantChunks = evaluationCase.relevantChunks ?? [];
  const normalizedAnswer = normalizeText(observation.answer);
  const matchedAnswerTerms = requiredTerms.filter((term) =>
    normalizedAnswer.includes(normalizeText(term)),
  ).length;
  const citedTitles = new Set(observation.citations.map((citation) => citation.title));
  const matchedDocuments = expectedDocuments.filter((title) => citedTitles.has(title)).length;
  const citedSourceTypes = new Set(observation.citations.map((citation) => citation.source.type));
  const matchedSourceTypes = expectedSourceTypes.filter((type) =>
    citedSourceTypes.has(type),
  ).length;
  const groundedCorrect = observation.grounded === evaluationCase.expectedGrounded;
  const injectionSafe = forbiddenTerms.every(
    (term) => !normalizedAnswer.includes(normalizeText(term)),
  );
  const relevantCitations = observation.citations.filter((citation) =>
    relevantChunks.some((relevant) =>
      matchesRelevantChunk(
        {
          title: citation.title,
          content: citation.excerpt ?? '',
          score: 0,
          source: citation.source,
        },
        relevant,
      ),
    ),
  ).length;
  const matchedRelevantChunks = relevantChunks.filter((relevant) =>
    observation.citations.some((citation) =>
      matchesRelevantChunk(
        {
          title: citation.title,
          content: citation.excerpt ?? '',
          score: 0,
          source: citation.source,
        },
        relevant,
      ),
    ),
  ).length;
  const passed =
    groundedCorrect &&
    matchedAnswerTerms === requiredTerms.length &&
    matchedDocuments === expectedDocuments.length &&
    matchedSourceTypes === expectedSourceTypes.length &&
    injectionSafe;

  return {
    id: evaluationCase.id,
    category: evaluationCase.category,
    iteration,
    passed,
    groundedCorrect,
    matchedAnswerTerms,
    requiredAnswerTerms: requiredTerms.length,
    matchedDocuments,
    expectedDocuments: expectedDocuments.length,
    matchedSourceTypes,
    expectedSourceTypes: expectedSourceTypes.length,
    relevantCitations,
    citationCount: observation.citations.length,
    matchedRelevantChunks,
    expectedRelevantChunks: relevantChunks.length,
    injectionSafe,
    latencyMs: observation.latencyMs,
    estimatedCostUsd: observation.estimatedCostUsd ?? 0,
    ...(observation.retrievalDiagnostics
      ? {
          retrieval: {
            candidateLimit: observation.retrievalDiagnostics.candidateLimit,
            scoreThreshold: observation.retrievalDiagnostics.scoreThreshold,
            mmrLambda: observation.retrievalDiagnostics.mmrLambda,
            nearDuplicateThreshold: observation.retrievalDiagnostics.nearDuplicateThreshold,
            consolidation: observation.retrievalDiagnostics.consolidation,
            timingsMs: observation.retrievalDiagnostics.timingsMs,
            stages: Object.fromEntries(
              RAG_EVALUATION_STAGES.map((stage) => [
                stage,
                evaluateStage(
                  observation.retrievalDiagnostics?.stages[stage].hits ?? [],
                  observation.retrievalDiagnostics?.stages[stage].candidateCount ?? 0,
                  relevantChunks,
                  cutoffs,
                ),
              ]),
            ) as Record<RagEvaluationStage, RagEvaluationStageCaseResult>,
          },
        }
      : {}),
  };
}

function evaluateStage(
  hits: RagEvaluationRetrievedChunk[],
  candidateCount: number,
  relevantChunks: RagEvaluationRelevantChunk[],
  cutoffs: number[],
): RagEvaluationStageCaseResult {
  const relevantRanks = relevantChunks.map((relevant) => {
    const index = hits.findIndex((hit) => matchesRelevantChunk(hit, relevant));
    return index < 0 ? null : index + 1;
  });
  return {
    candidateCount,
    relevantRanks,
    recallAtK: Object.fromEntries(
      cutoffs.map((cutoff) => [
        String(cutoff),
        ratio(
          relevantRanks.filter((rank) => rank !== null && rank <= cutoff).length,
          relevantChunks.length,
        ),
      ]),
    ),
    ndcgAtK: Object.fromEntries(
      cutoffs.map((cutoff) => [String(cutoff), ndcgAtK(hits, relevantChunks, cutoff)]),
    ),
  };
}

function summarizeRetrieval(
  results: RagEvaluationCaseResult[],
  cutoffs: number[],
  bootstrapSamples: number,
): RagEvaluationReport['retrieval'] {
  const diagnosticResults = results.filter((result) => result.retrieval !== undefined);
  const positiveResults = diagnosticResults.filter((result) => result.expectedRelevantChunks > 0);
  const stages = Object.fromEntries(
    RAG_EVALUATION_STAGES.map((stage, stageIndex) => {
      const recallAtK: Record<string, number> = {};
      const recallAtKConfidence95: Record<string, RagMetricConfidenceInterval> = {};
      const ndcgValuesAtK: Record<string, number> = {};
      const ndcgAtKConfidence95: Record<string, RagMetricConfidenceInterval> = {};
      for (const [cutoffIndex, cutoff] of cutoffs.entries()) {
        const key = String(cutoff);
        const recalls = positiveResults.map(
          (result) => result.retrieval?.stages[stage].recallAtK[key] ?? 0,
        );
        const ndcgs = positiveResults.map(
          (result) => result.retrieval?.stages[stage].ndcgAtK[key] ?? 0,
        );
        recallAtK[key] = round(mean(recalls), 4);
        recallAtKConfidence95[key] = bootstrapConfidenceInterval(
          recalls,
          mean,
          bootstrapSamples,
          101 + stageIndex * 31 + cutoffIndex,
          4,
        );
        ndcgValuesAtK[key] = round(mean(ndcgs), 4);
        ndcgAtKConfidence95[key] = bootstrapConfidenceInterval(
          ndcgs,
          mean,
          bootstrapSamples,
          401 + stageIndex * 31 + cutoffIndex,
          4,
        );
      }
      return [
        stage,
        {
          evaluatedCases: positiveResults.length,
          averageCandidateCount: round(
            mean(
              diagnosticResults.map(
                (result) => result.retrieval?.stages[stage].candidateCount ?? 0,
              ),
            ),
            2,
          ),
          recallAtK,
          recallAtKConfidence95,
          ndcgAtK: ndcgValuesAtK,
          ndcgAtKConfidence95,
        },
      ];
    }),
  ) as Record<RagEvaluationStage, RagEvaluationStageSummary>;

  const timingKeys: Array<keyof RagEvaluationRetrievalDiagnostics['timingsMs']> = [
    'settings',
    'embedding',
    'vector',
    'keyword',
    'fusion',
    'hydration',
    'rerank',
    'consolidation',
    'mmr',
    'total',
  ];
  const timingsMs = Object.fromEntries(
    timingKeys.map((key, index) => [
      key,
      summarizeDistribution(
        diagnosticResults.map((result) => result.retrieval?.timingsMs[key] ?? 0),
        bootstrapSamples,
        701 + index,
        2,
      ),
    ]),
  ) as Record<keyof RagEvaluationRetrievalDiagnostics['timingsMs'], RagDistributionSummary>;

  return { cutoffs, stages, timingsMs };
}

function matchesRelevantChunk(
  item: RagEvaluationRetrievedChunk,
  relevant: RagEvaluationRelevantChunk,
): boolean {
  if (normalizeText(item.title) !== normalizeText(relevant.documentTitle)) return false;
  const source = relevant.source;
  if (source?.type !== undefined && item.source.type !== source.type) return false;
  if (source?.page !== undefined && item.source.page !== source.page) return false;
  if (source?.slide !== undefined && item.source.slide !== source.slide) return false;
  if (source?.sheet !== undefined && item.source.sheet !== source.sheet) return false;
  if (
    source?.heading !== undefined &&
    normalizeText(item.source.heading ?? '') !== normalizeText(source.heading)
  ) {
    return false;
  }
  const content = normalizeText(item.content);
  return (relevant.contentIncludes ?? []).every((term) => content.includes(normalizeText(term)));
}

function ndcgAtK(
  hits: RagEvaluationRetrievedChunk[],
  relevantChunks: RagEvaluationRelevantChunk[],
  cutoff: number,
): number {
  if (relevantChunks.length === 0) return 1;
  const matchedRelevant = new Set<number>();
  const gains = hits.slice(0, cutoff).map((hit) => {
    const match = relevantChunks
      .map((candidate, index) => ({ candidate, index }))
      .filter(
        ({ candidate, index }) =>
          !matchedRelevant.has(index) && matchesRelevantChunk(hit, candidate),
      )
      .sort((left, right) => (right.candidate.relevance ?? 1) - (left.candidate.relevance ?? 1))[0];
    if (!match) return 0;
    matchedRelevant.add(match.index);
    return match.candidate.relevance ?? 1;
  });
  const ideal = relevantChunks
    .map((candidate) => candidate.relevance ?? 1)
    .sort((left, right) => right - left)
    .slice(0, cutoff);
  const idealDcg = discountedCumulativeGain(ideal);
  return idealDcg === 0 ? 0 : round(discountedCumulativeGain(gains) / idealDcg, 4);
}

function discountedCumulativeGain(relevances: number[]): number {
  return relevances.reduce(
    (total, relevance, index) => total + (2 ** relevance - 1) / Math.log2(index + 2),
    0,
  );
}

function summarizeDistribution(
  values: number[],
  bootstrapSamples: number,
  seed: number,
  digits: number,
): RagDistributionSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    total: round(total, digits),
    mean: round(mean(values), digits),
    min: round(sorted[0] ?? 0, digits),
    max: round(sorted.at(-1) ?? 0, digits),
    p50: round(percentile(sorted, 0.5), digits),
    p95: round(percentile(sorted, 0.95), digits),
    p99: round(percentile(sorted, 0.99), digits),
    meanConfidenceInterval95: bootstrapConfidenceInterval(
      values,
      mean,
      bootstrapSamples,
      seed,
      digits,
    ),
    p50ConfidenceInterval95: bootstrapConfidenceInterval(
      values,
      (sample) =>
        percentile(
          [...sample].sort((left, right) => left - right),
          0.5,
        ),
      bootstrapSamples,
      seed + 1,
      digits,
    ),
    p95ConfidenceInterval95: bootstrapConfidenceInterval(
      values,
      (sample) =>
        percentile(
          [...sample].sort((left, right) => left - right),
          0.95,
        ),
      bootstrapSamples,
      seed + 2,
      digits,
    ),
    p99ConfidenceInterval95: bootstrapConfidenceInterval(
      values,
      (sample) =>
        percentile(
          [...sample].sort((left, right) => left - right),
          0.99,
        ),
      bootstrapSamples,
      seed + 3,
      digits,
    ),
  };
}

function bootstrapConfidenceInterval(
  values: number[],
  statistic: (sample: number[]) => number,
  bootstrapSamples: number,
  seed: number,
  digits: number,
): RagMetricConfidenceInterval {
  if (values.length === 0) return { lower: 0, upper: 0 };
  if (values.length === 1) {
    const value = round(values[0] ?? 0, digits);
    return { lower: value, upper: value };
  }
  const random = seededRandom(seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < bootstrapSamples; iteration += 1) {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)] ?? 0,
    );
    estimates.push(statistic(sample));
  }
  estimates.sort((left, right) => left - right);
  return {
    lower: round(percentile(estimates, 0.025), digits),
    upper: round(percentile(estimates, 0.975), digits),
  };
}

function wilsonInterval(successes: number, total: number): RagMetricConfidenceInterval {
  if (total === 0) return { lower: 1, upper: 1 };
  const z = 1.959963984540054;
  const probability = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (probability + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((probability * (1 - probability)) / total + (z * z) / (4 * total * total))) /
    denominator;
  return {
    lower: round(Math.max(0, center - margin), 4),
    upper: round(Math.min(1, center + margin), 4),
  };
}

function normalizeCutoffs(cutoffs: number[]): number[] {
  const normalized = [...new Set(cutoffs.map((value) => positiveInteger(value, 'cutoff')))].sort(
    (left, right) => left - right,
  );
  if (normalized.length === 0) throw new Error('cutoffs must not be empty');
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : round(numerator / denominator, 4);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.max(0, index)] ?? 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
