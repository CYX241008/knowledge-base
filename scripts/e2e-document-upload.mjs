import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const tenantId = process.env.NEXT_PUBLIC_DEMO_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const sourcePath = process.argv[2];
const title = process.argv[3] ?? (sourcePath ? basename(sourcePath, extname(sourcePath)) : 'E2E');

if (!sourcePath) throw new Error('Usage: node scripts/e2e-document-upload.mjs <file> [title]');

const filename = basename(sourcePath);
const bytes = await readFile(resolve(sourcePath));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const mimeType = mimeTypeFor(filename);

const created = await request(`${apiBase}/documents/uploads`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tenantId,
    title,
    sourceFilename: filename,
    mimeType,
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
  `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/complete`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId }),
  },
);

if (completed.status !== 'ready') {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await request(`${apiBase}/ingestion/jobs/${completed.jobId}?tenantId=${tenantId}`);
    if (job.status === 'completed') break;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.errorMessage ?? `Ingestion ended with ${job.status}`);
    }
    if (attempt === 119) throw new Error('Timed out waiting for document ingestion');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
}

const detail = await request(`${apiBase}/documents/${created.documentId}?tenantId=${tenantId}`);
const version = detail.versions.find((item) => item.id === created.documentVersionId);
const markdownResponse = await fetch(
  `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/markdown?tenantId=${tenantId}`,
);
if (!markdownResponse.ok)
  throw new Error(`Markdown read failed with HTTP ${markdownResponse.status}`);
const markdown = await markdownResponse.text();

console.log(
  JSON.stringify(
    {
      documentId: created.documentId,
      documentVersionId: created.documentVersionId,
      status: version?.ingestionStatus,
      parserName: version?.parserName,
      parserVersion: version?.parserVersion,
      markdownCharacters: markdown.length,
      hasPageBoundaries: markdown.includes('## Page 1'),
      hasSheetBoundaries: markdown.includes('## Sheet:'),
      hasSlideBoundaries: markdown.includes('## Slide 1'),
      hasSignedAssetUrl: markdown.includes('X-Amz-Signature='),
    },
    null,
    2,
  ),
);

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
    '.markdown': 'text/markdown',
    '.pdf': 'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[extname(name).toLowerCase()] ?? 'application/octet-stream';
}
