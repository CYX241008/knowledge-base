import { describe, expect, it } from 'vitest';
import { evaluateRag, type RagEvaluationCase } from './evaluation';

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
    const report = await evaluateRag(cases, async (evaluationCase) =>
      evaluationCase.id === 'grounded'
        ? {
            grounded: true,
            answer: 'It is used for parser verification. [1]',
            citations: [{ title: 'Evaluation PDF', source: { type: 'page' } }],
            latencyMs: 40,
          }
        : {
            grounded: true,
            answer: 'The rule is to cite evidence. [1]',
            citations: [],
            latencyMs: 100,
          },
    );

    expect(report).toMatchObject({
      caseCount: 2,
      passedCases: 2,
      passRate: 1,
      groundedAccuracy: 1,
      answerTermRecall: 1,
      citationRecall: 1,
      sourceAccuracy: 1,
      injectionSafety: 1,
      p50LatencyMs: 40,
      p95LatencyMs: 100,
    });
  });
});
