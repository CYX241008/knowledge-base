import type { PdfPageClassification, StructuredDocument } from './structured-document';

export type PdfEvaluationCase = {
  page: number;
  classification?: PdfPageClassification;
  requiredText?: string[];
  expectedTableCells?: string[];
  requiredVisualTerms?: string[];
  requireBoundingBoxes?: boolean;
};

export type PdfEvaluationReport = {
  cases: number;
  classificationAccuracy: number;
  textRecall: number;
  tableCellRecall: number;
  visualTermRecall: number;
  locatableElementRate: number;
  passed: boolean;
};

export function evaluatePdfStructure(
  structure: StructuredDocument,
  cases: PdfEvaluationCase[],
): PdfEvaluationReport {
  let classifications = 0;
  let matchedClassifications = 0;
  let requiredText = 0;
  let matchedText = 0;
  let expectedCells = 0;
  let matchedCells = 0;
  let requiredVisualTerms = 0;
  let matchedVisualTerms = 0;
  let searchableElements = 0;
  let locatableElements = 0;
  for (const evaluationCase of cases) {
    const page = structure.pages.find((item) => item.page === evaluationCase.page);
    if (!page) continue;
    if (evaluationCase.classification) {
      classifications += 1;
      if (page.classification === evaluationCase.classification) matchedClassifications += 1;
    }
    const text = normalize(page.elements.map((element) => element.text).join(' '));
    for (const term of evaluationCase.requiredText ?? []) {
      requiredText += 1;
      if (text.includes(normalize(term))) matchedText += 1;
    }
    const tableText = normalize(
      structure.tables
        .filter((table) => table.page === evaluationCase.page)
        .flatMap((table) => table.rows.flat())
        .join(' '),
    );
    for (const cell of evaluationCase.expectedTableCells ?? []) {
      expectedCells += 1;
      if (tableText.includes(normalize(cell))) matchedCells += 1;
    }
    const visualText = normalize(
      page.elements
        .filter((element) => element.source === 'vision')
        .map((element) => element.text)
        .join(' '),
    );
    for (const term of evaluationCase.requiredVisualTerms ?? []) {
      requiredVisualTerms += 1;
      if (visualText.includes(normalize(term))) matchedVisualTerms += 1;
    }
    if (evaluationCase.requireBoundingBoxes) {
      for (const element of page.elements.filter((item) => item.searchable)) {
        searchableElements += 1;
        if (element.bbox) locatableElements += 1;
      }
    }
  }
  const report = {
    cases: cases.length,
    classificationAccuracy: ratio(matchedClassifications, classifications),
    textRecall: ratio(matchedText, requiredText),
    tableCellRecall: ratio(matchedCells, expectedCells),
    visualTermRecall: ratio(matchedVisualTerms, requiredVisualTerms),
    locatableElementRate: ratio(locatableElements, searchableElements),
    passed: false,
  };
  report.passed =
    report.classificationAccuracy === 1 &&
    report.textRecall === 1 &&
    report.tableCellRecall === 1 &&
    report.visualTermRecall === 1 &&
    report.locatableElementRate >= 0.8;
  return report;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function ratio(matched: number, total: number): number {
  return total === 0 ? 1 : matched / total;
}
