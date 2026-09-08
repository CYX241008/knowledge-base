import { createHash } from 'node:crypto';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const headers = { 'content-type': 'application/json' };
const suffix = Date.now();
const alpha = `planner-alpha-${suffix}`;
const beta = `planner-beta-${suffix}`;
const factPhrase = `查询规划验收短语${suffix}`;
const filename = `planner-${suffix}.md`;
let documentId;
let conversationId;

try {
  const settings = await request(`${apiBase}/admin/settings`);
  const created = await uploadDocument();
  documentId = created.documentId;
  await publishVersion(created.documentId, created.documentVersionId);
  await waitForSearch(alpha, created.documentId);

  const exact = await search(`查看 ${filename} 的内容`, 10);
  if (exact.diagnostics?.queryPlan?.intent !== 'exact') {
    throw new Error('Filename query was not classified as exact');
  }
  if (
    exact.diagnostics.queryPlan.version !== 'query-planner-v1' ||
    !exact.diagnostics.queryPlan.enabled
  ) {
    throw new Error('Query planner version or feature flag was not exposed');
  }
  if (exact.diagnostics.queryPlan.candidateLimit >= settings.retrieval.candidateLimit) {
    throw new Error('Exact query did not reduce the candidate window');
  }
  if (exact.pageSize !== 10 || exact.diagnostics.queryPlan.resultLimit !== 10) {
    throw new Error('Direct search pagination was changed by dynamic K');
  }

  const comparison = await search(`比较 ${alpha} 和 ${beta} 的区别`, 10);
  if (comparison.diagnostics?.queryPlan?.intent !== 'comparison') {
    throw new Error('Comparison query was not classified correctly');
  }
  const subqueries = comparison.diagnostics.queryPlan.variants
    .filter((variant) => variant.kind === 'subquery')
    .map((variant) => variant.text);
  if (!subqueries.includes(alpha) || !subqueries.includes(beta)) {
    throw new Error(`Comparison query was not decomposed: ${subqueries.join(', ')}`);
  }
  if (comparison.diagnostics.queryPlan.candidateLimit < settings.retrieval.candidateLimit) {
    throw new Error('Comparison query unexpectedly reduced the candidate window');
  }

  const answer = await request(`${apiBase}/answers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question: `请问怎么使用${factPhrase}？`,
      limit: 8,
      includeDiagnostics: true,
    }),
  });
  conversationId = answer.conversationId;
  if (answer.retrievalDiagnostics?.queryPlan?.intent !== 'fact') {
    throw new Error('Factual answer query was not classified correctly');
  }
  if (answer.retrievalDiagnostics.queryPlan.resultLimit !== 5) {
    throw new Error('Factual answer query did not reduce evidence K to 5');
  }

  console.log(
    JSON.stringify(
      {
        documentId,
        exact: exact.diagnostics.queryPlan,
        comparison: comparison.diagnostics.queryPlan,
        answer: answer.retrievalDiagnostics.queryPlan,
        directPaginationPreserved: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (conversationId) {
    await request(`${apiBase}/answers/conversations/${conversationId}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  if (documentId) {
    await request(`${apiBase}/documents/${documentId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
}

async function uploadDocument() {
  const content = Buffer.from(
    [
      '# Query planning acceptance',
      '',
      `## ${alpha}`,
      '',
      `${alpha} uses vector retrieval for semantic matching.`,
      '',
      `## ${beta}`,
      '',
      `${beta} uses keyword retrieval for exact matching.`,
      '',
      `## ${factPhrase}`,
      '',
      `${factPhrase}用于验证事实问题会采用较小的证据数量。`,
    ].join('\n'),
  );
  const sha256 = createHash('sha256').update(content).digest('hex');
  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `Query Planning E2E ${suffix}`,
      sourceFilename: filename,
      mimeType: 'text/markdown',
      sizeBytes: content.byteLength,
      sha256,
    }),
  });
  const upload = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: created.uploadHeaders,
    body: content,
  });
  if (!upload.ok) throw new Error(`Object upload failed with HTTP ${upload.status}`);
  const completed = await request(
    `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/complete`,
    { method: 'POST', headers, body: '{}' },
  );
  await waitForReady(completed.jobId, completed.status);
  return created;
}

function publishVersion(targetDocumentId, versionId) {
  return request(`${apiBase}/documents/${targetDocumentId}/versions/${versionId}/publish`, {
    method: 'POST',
    headers,
    body: '{}',
  });
}

function search(text, limit) {
  return request(`${apiBase}/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text, page: 1, limit, includeDiagnostics: true }),
  });
}

async function waitForSearch(text, targetDocumentId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await search(text, 10);
    if (result.hits.some((hit) => hit.documentId === targetDocumentId)) return;
    await delay(250);
  }
  throw new Error('Timed out waiting for the query-planning search projection');
}

async function waitForReady(jobId, initialStatus) {
  if (initialStatus === 'ready') return;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const job = await request(`${apiBase}/ingestion/jobs/${jobId}`);
    if (job.status === 'completed') return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.errorMessage ?? `Ingestion ended with ${job.status}`);
    }
    await delay(250);
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
