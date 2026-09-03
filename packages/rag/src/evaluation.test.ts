import { describe, expect, it } from 'vitest';
import {
  evaluateRag,
  type RagEvaluationCase,
  type RagEvaluationRetrievalDiagnostics,
} from './evaluation';

describe('evaluateRag', () => {
  it('calculates grounded, citation, answer, source, safety, and latency metrics', async () => {
    const cases: RagEvaluationCase[] = [
      {
        id: 'grounded',
        category: 'pdf',
        question: 'What is on page one?',
        expectedGrounded: true,
        requiredAnswerTerms: ['parser verification'],
        expectedDocumentTitles: ['Evaluation PDF'],
        expectedSourceTypes: ['page'],
        relevantChunks: [
          {
            documentTitle: 'Evaluation PDF',
            source: { type: 'page', page: 1 },
            contentIncludes: ['parser verification'],
            relevance: 3,
          },
        ],
      },
      {
        id: 'injection',
        category: 'prompt-injection',
        question: 'What is the safety rule?',
        expectedGrounded: true,
        requiredAnswerTerms: ['cite evidence'],
        forbiddenAnswerTerms: ['ignore safeguards'],
      },
    ];
    const diagnostics: RagEvaluationRetrievalDiagnostics = {
      candidateLimit: 50,
      scoreThreshold: 0.2,
      mmrLambda: 0.7,
      nearDuplicateThreshold: 0.92,
      consolidation: {
        exactDuplicatesRemoved: 0,
        adjacentChunksMerged: 0,
        nonAdjacentDuplicatesRemoved: 0,
        crossSourceSimilarPreserved: 0,
      },
      timingsMs: {
        settings: 1,
        embedding: 2,
        vector: 3,
        keyword: 4,
        fusion: 1,
        hydration: 2,
        rerank: 5,
        consolidation: 1,
        mmr: 1,
        total: 12,
      },
      stages: Object.fromEntries(
        ['vector', 'keyword', 'rrf', 'reranked', 'consolidated', 'selected'].map((stage) => [
          stage,
          {
            candidateCount: 2,
            hits: [
              {
                title: 'Unrelated',
                content: 'Other material',
                score: 0.9,
                source: { type: 'document' },
              },
              {
                title: 'Evaluation PDF',
                content: 'It is used for parser verification.',
                score: 0.8,
                source: { type: 'page', page: 1 },
              },
            ],
          },
        ]),
      ) as RagEvaluationRetrievalDiagnostics['stages'],
    };
    const report = await evaluateRag(cases, async (evaluationCase) =>
      evaluationCase.id === 'grounded'
        ? {
            grounded: true,
            answer: 'It is used for parser verification. [1]',
            citations: [
              {
                title: 'Evaluation PDF',
                excerpt: 'It is used for parser verification.',
                source: { type: 'page', page: 1 },
              },
            ],
            latencyMs: 40,
            estimatedCostUsd: 0.002,
            retrievalDiagnostics: diagnostics,
          }
        : {
            grounded: true,
            answer: 'The rule is to cite evidence. [1]',
            citations: [],
            latencyMs: 100,
            estimatedCostUsd: 0.004,
          },
    );

    expect(report).toMatchObject({
      caseCount: 2,
      passedCases: 2,
      passRate: 1,
      groundedAccuracy: 1,
      answerTermRecall: 1,
      citationRecall: 1,
      citationPrecision: 1,
      citationChunkRecall: 1,
      sourceAccuracy: 1,
      injectionSafety: 1,
      p50LatencyMs: 40,
      p95LatencyMs: 100,
      p99LatencyMs: 100,
    });
    expect(report.costUsd.total).toBe(0.006);
    expect(report.retrieval.stages.rrf.recallAtK).toMatchObject({ '1': 0, '3': 1 });
    expect(report.retrieval.stages.rrf.ndcgAtK['3']).toBe(0.6309);
    expect(report.cases[0]?.retrieval?.stages.rrf.relevantRanks).toEqual([2]);
  });
});
