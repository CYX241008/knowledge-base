import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { evaluateRag } from '../packages/rag/dist/index.js';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const options = parseOptions(process.argv.slice(2));
const datasetPath = resolve(options.datasetPath);
const dataset = JSON.parse(await readFile(datasetPath, 'utf8'));
const documentIds = [];
const conversationIds = new Set();
const reports = [];
let originalSettings;
let settingsChanged = false;
let outputPath;

try {
  originalSettings = await request(`${apiBase}/admin/settings`);
  const candidateLimits = options.candidateLimits.length
    ? options.candidateLimits
    : [originalSettings.retrieval.candidateLimit];

  for (const document of dataset.documents) {
    await uploadDocument(document.path, document.title);
  }

  for (const candidateLimit of candidateLimits) {
    if (candidateLimit !== originalSettings.retrieval.candidateLimit || settingsChanged) {
      await updateCandidateLimit(originalSettings, candidateLimit);
      settingsChanged = true;
    }
    const settings = await request(`${apiBase}/admin/settings`);
    const metricsBefore = await request(`${apiBase}/metrics/models`);
    const report = await evaluateRag(
      dataset.cases,
      async (evaluationCase) => {
        const observationMetricsBefore = await request(`${apiBase}/metrics/models`);
        const startedAt = performance.now();
        const answer = await request(`${apiBase}/answers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            question: evaluationCase.question,
            limit: options.answerLimit,
            includeDiagnostics: true,
          }),
        });
        const latencyMs = Math.round(performance.now() - startedAt);
        const observationMetricsAfter = await request(`${apiBase}/metrics/models`);
        conversationIds.add(answer.conversationId);
        return {
          grounded: answer.grounded,
          answer: answer.answer,
          citations: answer.citations,
          latencyMs,
          estimatedCostUsd: round(
            Math.max(
              0,
              totalEstimatedCost(observationMetricsAfter) -
                totalEstimatedCost(observationMetricsBefore),
            ),
            8,
          ),
          retrievalDiagnostics: answer.retrievalDiagnostics,
        };
      },
      {
        repetitions: options.repetitions,
        cutoffs: options.cutoffs,
        bootstrapSamples: options.bootstrapSamples,
      },
    );
    const metricsAfter = await request(`${apiBase}/metrics/models`);
    reports.push({
      parameters: {
        candidateLimit: settings.retrieval.candidateLimit,
        searchScoreThreshold: settings.retrieval.scoreThreshold,
        ragMinRelevance: settings.runtime.ragMinRelevance,
        mmrLambda: settings.runtime.mmrLambda,
        nearDuplicateThreshold: settings.runtime.nearDuplicateThreshold,
        answerLimit: options.answerLimit,
        embeddingModel: settings.runtime.embeddingModel,
        rerankerProvider: settings.runtime.rerankerProvider,
        rerankerModel: settings.runtime.rerankerModel,
        chatModel: settings.runtime.chatModel,
      },
      report,
      modelMetricsDelta: subtractModelMetrics(metricsAfter, metricsBefore),
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    dataset: {
      path: datasetPath,
      documentCount: dataset.documents.length,
      caseCount: dataset.cases.length,
    },
    repetitions: options.repetitions,
    cutoffs: options.cutoffs,
    reports,
  };
  outputPath = await writeReport(output, options.outputDir);
  console.log(
    JSON.stringify(
      {
        outputPath,
        generatedAt: output.generatedAt,
        dataset: output.dataset,
        repetitions: output.repetitions,
        reports: reports.map((item) => ({
          parameters: item.parameters,
          passRate: item.report.passRate,
          citationPrecision: item.report.citationPrecision,
          citationChunkRecall: item.report.citationChunkRecall,
          p50LatencyMs: item.report.p50LatencyMs,
          p95LatencyMs: item.report.p95LatencyMs,
          p99LatencyMs: item.report.p99LatencyMs,
          rrfRecallAtK: item.report.retrieval.stages.rrf.recallAtK,
          rerankedNdcgAtK: item.report.retrieval.stages.reranked.ndcgAtK,
          estimatedCostUsd: item.modelMetricsDelta.estimatedCostUsd,
        })),
      },
      null,
      2,
    ),
  );

  const failedCases = reports.reduce(
    (total, item) => total + item.report.caseCount - item.report.passedCases,
    0,
  );
  if (failedCases > 0) throw new Error(`RAG evaluation failed ${failedCases} observation(s)`);
} finally {
  if (originalSettings && settingsChanged) {
    await updateCandidateLimit(originalSettings, originalSettings.retrieval.candidateLimit).catch(
      (error) => console.error(`Failed to restore original settings: ${error.message}`),
    );
  }
  for (const conversationId of conversationIds) {
    await request(`${apiBase}/answers/conversations/${conversationId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
  for (const documentId of documentIds) {
    await request(`${apiBase}/documents/${documentId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
}

async function updateCandidateLimit(settings, candidateLimit) {
  return request(`${apiBase}/admin/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      retrieval: { ...settings.retrieval, candidateLimit },
      governance: settings.governance,
    }),
  });
}

async function writeReport(output, outputDirectory) {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const timestamp = output.generatedAt.replaceAll(':', '-').replaceAll('.', '-');
  const path = resolve(directory, `rag-evaluation-${timestamp}.json`);
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  return path;
}

function parseOptions(args) {
  const optionValues = new Map();
  let datasetPath = 'packages/rag/test-fixtures/rag-evaluation.json';
  for (const argument of args) {
    if (argument === '--') continue;
    if (!argument.startsWith('--')) {
      datasetPath = argument;
      continue;
    }
    const [key, value] = argument.slice(2).split('=', 2);
    if (!key || value === undefined) throw new Error(`Expected --name=value, got ${argument}`);
    optionValues.set(key, value);
  }
  return {
    datasetPath,
    repetitions: positiveInteger(optionValues.get('repetitions') ?? '1', 'repetitions'),
    candidateLimits: boundedIntegerList(
      optionValues.get('candidate-limits'),
      'candidate-limits',
      50,
      500,
    ),
    cutoffs: integerList(optionValues.get('cutoffs') ?? '1,3,5,8,10,20,50', 'cutoffs'),
    answerLimit: boundedInteger(optionValues.get('answer-limit') ?? '8', 'answer-limit', 1, 12),
    bootstrapSamples: positiveInteger(
      optionValues.get('bootstrap-samples') ?? '1000',
      'bootstrap-samples',
    ),
    outputDir:
      optionValues.get('output-dir') ?? process.env.RAG_EVAL_OUTPUT_DIR ?? '.tmp/rag-evaluations',
  };
}

function integerList(value, name) {
  if (value === undefined || value.trim() === '') return [];
  return [...new Set(value.split(',').map((item) => positiveInteger(item.trim(), name)))].sort(
    (left, right) => left - right,
  );
}

function boundedIntegerList(value, name, minimum, maximum) {
  return integerList(value, name).map((item) => {
    if (item < minimum || item > maximum) {
      throw new Error(`${name} values must be between ${minimum} and ${maximum}`);
    }
    return item;
  });
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must contain positive integers`);
  }
  return parsed;
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = positiveInteger(value, name);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function subtractModelMetrics(after, before) {
  const beforeByKey = new Map(
    before.operations.map((operation) => [`${operation.operation}:${operation.model}`, operation]),
  );
  const operations = after.operations
    .map((operation) => {
      const previous = beforeByKey.get(`${operation.operation}:${operation.model}`);
      return {
        operation: operation.operation,
        model: operation.model,
        calls: operation.calls - (previous?.calls ?? 0),
        success: operation.success - (previous?.success ?? 0),
        errors: operation.errors - (previous?.errors ?? 0),
        cancelled: operation.cancelled - (previous?.cancelled ?? 0),
        rejected: operation.rejected - (previous?.rejected ?? 0),
        retries: operation.retries - (previous?.retries ?? 0),
        durationMs: operation.durationMs - (previous?.durationMs ?? 0),
        inputTokens: operation.inputTokens - (previous?.inputTokens ?? 0),
        outputTokens: operation.outputTokens - (previous?.outputTokens ?? 0),
        totalTokens: operation.totalTokens - (previous?.totalTokens ?? 0),
        estimatedCostUsd: round(operation.estimatedCostUsd - (previous?.estimatedCostUsd ?? 0), 8),
      };
    })
    .filter(
      (operation) =>
        operation.calls !== 0 || operation.totalTokens !== 0 || operation.estimatedCostUsd !== 0,
    );
  return {
    calls: operations.reduce((sum, operation) => sum + operation.calls, 0),
    totalTokens: operations.reduce((sum, operation) => sum + operation.totalTokens, 0),
    estimatedCostUsd: round(
      operations.reduce((sum, operation) => sum + operation.estimatedCostUsd, 0),
      8,
    ),
    operations,
  };
}

function totalEstimatedCost(metrics) {
  return metrics.operations.reduce((total, operation) => total + operation.estimatedCostUsd, 0);
}

async function uploadDocument(relativePath, title) {
  const sourcePath = resolve(relativePath);
  const bytes = await readFile(sourcePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = basename(sourcePath);
  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      sourceFilename: filename,
      mimeType: mimeTypeFor(filename),
      sizeBytes: bytes.byteLength,
      sha256,
    }),
  });
  documentIds.push(created.documentId);
  const upload = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: created.uploadHeaders,
    body: bytes,
  });
  if (!upload.ok) throw new Error(`Object upload failed with HTTP ${upload.status}`);
  const completed = await request(
    `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/complete`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  await waitForReady(completed);
  await request(
    `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/publish`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
}

async function waitForReady(completed) {
  if (completed.status === 'ready') return;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const job = await request(`${apiBase}/ingestion/jobs/${completed.jobId}`);
    if (job.status === 'completed') return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.errorMessage ?? `Ingestion ended with ${job.status}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('Timed out waiting for document ingestion');
}

async function request(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(
      body?.error?.message ?? body?.message ?? `Request failed with HTTP ${response.status}`,
    );
  }
  return body.data;
}

function mimeTypeFor(name) {
  const types = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
