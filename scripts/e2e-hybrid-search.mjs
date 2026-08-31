import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const tenantId = process.env.NEXT_PUBLIC_DEMO_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const sourcePath = resolve(process.argv[2] ?? 'packages/rag/test-fixtures/search-sample.md');
const principalId = `tenant:${tenantId}`;
const bytes = await readFile(sourcePath);
const sha256 = createHash('sha256').update(bytes).digest('hex');

const created = await request(`${apiBase}/documents/uploads`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tenantId,
    title: 'Phase 6 Hybrid Search E2E',
    sourceFilename: basename(sourcePath),
    mimeType: 'text/markdown',
    sizeBytes: bytes.byteLength,
    sha256,
    principalIds: [principalId],
  }),
});
const uploaded = await fetch(created.uploadUrl, {
  method: 'PUT',
  headers: created.uploadHeaders,
  body: bytes,
});
if (!uploaded.ok) throw new Error(`Object upload failed with HTTP ${uploaded.status}`);
const completed = await request(
  `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/complete`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  },
);
for (let attempt = 0; completed.status !== 'ready' && attempt < 120; attempt += 1) {
  const job = await request(`${apiBase}/ingestion/jobs/${completed.jobId}?tenantId=${tenantId}`);
  if (job.status === 'completed') break;
  if (job.status === 'failed' || job.status === 'cancelled')
    throw new Error(job.errorMessage ?? `Ingestion ended with ${job.status}`);
  if (attempt === 119) throw new Error('Timed out waiting for document ingestion');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
}

const result = await search();
const hit = result.hits.find((item) => item.documentId === created.documentId);
if (!hit) throw new Error('Authenticated search did not return the indexed document');

console.log(
  JSON.stringify(
    {
      documentId: created.documentId,
      documentVersionId: created.documentVersionId,
      authenticatedHits: result.hits.length,
      spoofedIdentityIgnored: true,
      source: hit.source,
      score: hit.score,
    },
    null,
    2,
  ),
);

async function search() {
  return request(`${apiBase}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      principalIds: ['role:forged-client-principal'],
      text: '量子凤梨索引',
      limit: 10,
    }),
  });
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
