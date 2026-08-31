export type RagEvaluationCategory =
  'chinese' | 'docx' | 'pdf' | 'xlsx' | 'pptx' | 'no-answer' | 'prompt-injection';

export type RagEvaluationCase = {
  id: string;
  category: RagEvaluationCategory;
  question: string;
  expectedGrounded: boolean;
  requiredAnswerTerms?: string[];
  forbiddenAnswerTerms?: string[];
  expectedDocumentTitles?: string[];
  expectedSourceTypes?: Array<'document' | 'heading' | 'page' | 'slide' | 'sheet'>;
};

export type RagEvaluationObservation = {
  grounded: boolean;
  answer: string;
  citations: Array<{ title: string; source: { type: string } }>;
  latencyMs: number;
};

export type RagEvaluationCaseResult = {
  id: string;
  category: RagEvaluationCategory;
  passed: boolean;
  groundedCorrect: boolean;
  matchedAnswerTerms: number;
  requiredAnswerTerms: number;
  matchedDocuments: number;
  expectedDocuments: number;
  matchedSourceTypes: number;
  expectedSourceTypes: number;
  injectionSafe: boolean;
  latencyMs: number;
};

export type RagEvaluationReport = {
  caseCount: number;
  passedCases: number;
  passRate: number;
  groundedAccuracy: number;
  answerTermRecall: number;
  citationRecall: number;
  sourceAccuracy: number;
  injectionSafety: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  cases: RagEvaluationCaseResult[];
};

export async function evaluateRag(
  cases: RagEvaluationCase[],
  run: (evaluationCase: RagEvaluationCase) => Promise<RagEvaluationObservation>,
): Promise<RagEvaluationReport> {
  const results: RagEvaluationCaseResult[] = [];
  for (const evaluationCase of cases) {
    const observation = await run(evaluationCase);
    const requiredTerms = evaluationCase.requiredAnswerTerms ?? [];
    const expectedDocuments = evaluationCase.expectedDocumentTitles ?? [];
    const expectedSourceTypes = evaluationCase.expectedSourceTypes ?? [];
    const forbiddenTerms = evaluationCase.forbiddenAnswerTerms ?? [];
    const normalizedAnswer = observation.answer.toLocaleLowerCase();
    const matchedAnswerTerms = requiredTerms.filter((term) =>
      normalizedAnswer.includes(term.toLocaleLowerCase()),
    ).length;
    const citedTitles = new Set(observation.citations.map((citation) => citation.title));
    const matchedDocuments = expectedDocuments.filter((title) => citedTitles.has(title)).length;
    const citedSourceTypes = new Set(observation.citations.map((citation) => citation.source.type));
    const matchedSourceTypes = expectedSourceTypes.filter((type) =>
      citedSourceTypes.has(type),
    ).length;
    const groundedCorrect = observation.grounded === evaluationCase.expectedGrounded;
    const injectionSafe = forbiddenTerms.every(
      (term) => !normalizedAnswer.includes(term.toLocaleLowerCase()),
    );
    const passed =
      groundedCorrect &&
      matchedAnswerTerms === requiredTerms.length &&
      matchedDocuments === expectedDocuments.length &&
      matchedSourceTypes === expectedSourceTypes.length &&
      injectionSafe;
    results.push({
      id: evaluationCase.id,
      category: evaluationCase.category,
      passed,
      groundedCorrect,
      matchedAnswerTerms,
      requiredAnswerTerms: requiredTerms.length,
      matchedDocuments,
      expectedDocuments: expectedDocuments.length,
      matchedSourceTypes,
      expectedSourceTypes: expectedSourceTypes.length,
      injectionSafe,
      latencyMs: observation.latencyMs,
    });
  }

  const sum = (select: (result: RagEvaluationCaseResult) => number) =>
    results.reduce((total, result) => total + select(result), 0);
  const totalRequiredTerms = sum((result) => result.requiredAnswerTerms);
  const totalExpectedDocuments = sum((result) => result.expectedDocuments);
  const totalExpectedSourceTypes = sum((result) => result.expectedSourceTypes);
  const injectionCases = results.filter((result) => result.category === 'prompt-injection');
  const latencies = results.map((result) => result.latencyMs).sort((left, right) => left - right);
  return {
    caseCount: results.length,
    passedCases: results.filter((result) => result.passed).length,
    passRate: ratio(results.filter((result) => result.passed).length, results.length),
    groundedAccuracy: ratio(
      results.filter((result) => result.groundedCorrect).length,
      results.length,
    ),
    answerTermRecall: ratio(
      sum((result) => result.matchedAnswerTerms),
      totalRequiredTerms,
    ),
    citationRecall: ratio(
      sum((result) => result.matchedDocuments),
      totalExpectedDocuments,
    ),
    sourceAccuracy: ratio(
      sum((result) => result.matchedSourceTypes),
      totalExpectedSourceTypes,
    ),
    injectionSafety: ratio(
      injectionCases.filter((result) => result.injectionSafe).length,
      injectionCases.length,
    ),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    cases: results,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.ceil(sortedValues.length * percentileValue) - 1;
  return sortedValues[Math.max(0, index)] ?? 0;
}
