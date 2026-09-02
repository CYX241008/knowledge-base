import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { evaluateRag } from '../packages/rag/dist/index.js';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const datasetPath = resolve(process.argv[2] ?? 'packages/rag/test-fixtures/rag-evaluation.json');
const dataset = JSON.parse(await readFile(datasetPath, 'utf8'));
const documentIds = [];
const conversationIds = new Set();

try {
  for (const document of dataset.documents) {
    await uploadDocument(document.path, document.title);
  }

  const report = await evaluateRag(dataset.cases, async (evaluationCase) => {
    const startedAt = performance.now();
    const answer = await request(`${apiBase}/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: evaluationCase.question, limit: 8 }),
    });
    conversationIds.add(answer.conversationId);
    return {
      grounded: answer.grounded,
      answer: answer.answer,
      citations: answer.citations,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  });
  const modelMetrics = await request(`${apiBase}/metrics/models`);
  console.log(JSON.stringify({ report, modelMetrics }, null, 2));
  if (report.passedCases !== report.caseCount) {
    throw new Error(`RAG evaluation failed ${report.caseCount - report.passedCases} case(s)`);
  }
} finally {
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
