import { createHash } from 'node:crypto';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const tenantId = process.env.NEXT_PUBLIC_DEMO_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const documentId = process.argv[2];
const expectedReadyVersionId = process.argv[3];

if (!documentId || !expectedReadyVersionId) {
  throw new Error(
    'Usage: node scripts/e2e-ingestion-reliability.mjs <documentId> <expectedReadyVersionId>',
  );
}

const bytes = new TextEncoder().encode('%PDF-1.4\nThis is intentionally not a valid PDF.\n%%EOF');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const created = await request(`${apiBase}/documents/uploads`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tenantId,
    documentId,
    title: 'Phase 5 controlled failure',
    sourceFilename: 'controlled-failure.pdf',
    mimeType: 'application/pdf',
    sizeBytes: bytes.byteLength,
    sha256,
  }),
});
const upload = await fetch(created.uploadUrl, {
  method: 'PUT',
  headers: created.uploadHeaders,
  body: bytes,
});
if (!upload.ok) throw new Error(`Object upload failed with HTTP ${upload.status}`);

const completed = await request(
  `${apiBase}/documents/${documentId}/versions/${created.documentVersionId}/complete`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  },
);
const failedJob = await waitForStatus(completed.jobId, 'failed');
if (failedJob.attempts !== 3 || !failedJob.deadLetteredAt) {
  throw new Error('Expected three attempts and a dead-letter timestamp');
}

const detail = await request(`${apiBase}/documents/${documentId}?tenantId=${tenantId}`);
if (detail.document.currentReadyVersionId !== expectedReadyVersionId) {
  throw new Error('Failed version replaced the current ready version');
}

await request(`${apiBase}/ingestion/jobs/${completed.jobId}/retry`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tenantId }),
});
await request(`${apiBase}/ingestion/jobs/${completed.jobId}/cancel`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tenantId }),
});
const cancelledJob = await waitForStatus(completed.jobId, 'cancelled');
if (cancelledJob.generation !== 2) throw new Error('Manual retry did not advance generation');

await request(`${apiBase}/documents/${documentId}?tenantId=${tenantId}`, { method: 'DELETE' });
await delay(7_000);

console.log(
  JSON.stringify(
    {
      documentId,
      failedVersionId: created.documentVersionId,
      oldReadyVersionPreserved: detail.document.currentReadyVersionId === expectedReadyVersionId,
      automaticAttempts: failedJob.attempts,
      deadLettered: Boolean(failedJob.deadLetteredAt),
      retryGeneration: cancelledJob.generation,
      cancelled: cancelledJob.status === 'cancelled',
      deletionRequested: true,
    },
    null,
    2,
  ),
);

async function waitForStatus(jobId, expectedStatus) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const job = await request(`${apiBase}/ingestion/jobs/${jobId}?tenantId=${tenantId}`);
    if (job.status === expectedStatus) return job;
    if (expectedStatus !== 'failed' && job.status === 'failed') {
      throw new Error(job.errorMessage ?? 'Ingestion failed before reaching expected status');
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ingestion status ${expectedStatus}`);
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
