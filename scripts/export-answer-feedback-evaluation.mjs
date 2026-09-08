import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const options = parseOptions(process.argv.slice(2));
const params = new URLSearchParams({
  days: String(options.days),
  limit: String(options.limit),
});
const response = await request(`${apiBase}/admin/evaluation-candidates?${params}`);
const generatedAt = new Date().toISOString();
const output = {
  generatedAt,
  annotationRequired: true,
  source: {
    type: 'answer-feedback',
    days: options.days,
    limit: options.limit,
  },
  candidates: response.items.map((item) => ({
    ...item,
    evaluationCaseDraft: {
      id: `feedback-${item.feedbackId}`,
      question: item.question,
      expectedGrounded: null,
      requiredAnswerTerms: [],
      forbiddenAnswerTerms: [],
      expectedDocumentTitles: [...new Set(item.citations.map((citation) => citation.title))],
      expectedSourceTypes: [...new Set(item.citations.map((citation) => citation.source.type))],
      relevantChunks: item.citations.map((citation) => ({
        documentTitle: citation.title,
        source: {
          type: citation.source.type,
          page: citation.source.page,
          slide: citation.source.slide,
          sheet: citation.source.sheet,
          heading: citation.source.heading,
        },
        contentIncludes: [],
        relevance: null,
      })),
    },
  })),
};
const outputPath = await writeOutput(output, options.outputDir);
console.log(
  JSON.stringify(
    {
      outputPath,
      generatedAt,
      candidateCount: output.candidates.length,
      annotationRequired: true,
    },
    null,
    2,
  ),
);

function parseOptions(args) {
  const values = new Map();
  for (const argument of args) {
    if (argument === '--') continue;
    const [key, value] = argument.replace(/^--/u, '').split('=', 2);
    if (!key || value === undefined) throw new Error(`Expected --name=value, got ${argument}`);
    values.set(key, value);
  }
  return {
    days: boundedInteger(values.get('days') ?? '30', 'days', 1, 365),
    limit: boundedInteger(values.get('limit') ?? '100', 'limit', 1, 500),
    outputDir:
      values.get('output-dir') ?? process.env.RAG_EVAL_OUTPUT_DIR ?? '.tmp/rag-evaluations',
  };
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

async function writeOutput(output, outputDirectory) {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const timestamp = output.generatedAt.replaceAll(':', '-').replaceAll('.', '-');
  const path = resolve(directory, `answer-feedback-candidates-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return path;
}

async function request(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(
      body?.error?.message ?? body?.message ?? `Request failed with HTTP ${response.status}`,
    );
  }
  return body.data;
}
