import { createHash } from 'node:crypto';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const jsonHeaders = { 'content-type': 'application/json' };
const suffix = Date.now();
const oldMarker = `review-old-${suffix}`;
const newMarker = `review-new-${suffix}`;
let documentId;

try {
  const first = await uploadVersion({
    title: `Review E2E ${suffix}`,
    filename: `review-old-${suffix}.md`,
    content: `# Published baseline\n\n${oldMarker} remains visible while a new version is reviewed.`,
  });
  documentId = first.documentId;
  await expectVersionVisibility(oldMarker, first.documentVersionId, false);
  await publishVersion(documentId, first.documentVersionId);
  await expectVersionVisibility(oldMarker, first.documentVersionId, true);

  const second = await uploadVersion({
    documentId,
    title: `Review E2E ${suffix}`,
    filename: `review-new-${suffix}.md`,
    content: `# Pending replacement\n\n${newMarker} becomes visible only after approval.`,
  });
  await expectVersionVisibility(newMarker, second.documentVersionId, false);
  await expectVersionVisibility(oldMarker, first.documentVersionId, true);

  const withdrawn = await submitReview(documentId, second.documentVersionId, 'First review');
  await expectRequestStatus(
    `${apiBase}/documents/${documentId}/versions/${second.documentVersionId}/publish`,
    { method: 'POST', headers: jsonHeaders, body: '{}' },
    400,
  );
  await request(
    `${apiBase}/documents/${documentId}/versions/${second.documentVersionId}/reviews/withdraw`,
    { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ comment: 'Needs revision' }) },
  );

  const rejected = await submitReview(documentId, second.documentVersionId, 'Second review');
  await request(`${apiBase}/reviews/tasks/${rejected.id}/reject`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ comment: 'Please correct the evidence' }),
  });

  const approved = await submitReview(documentId, second.documentVersionId, 'Final review');
  await request(`${apiBase}/reviews/tasks/${approved.id}/approve`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ comment: 'Approved for publication' }),
  });
  await expectVersionVisibility(newMarker, second.documentVersionId, true);
  await expectVersionVisibility(oldMarker, first.documentVersionId, false);

  const tasks = await request(`${apiBase}/reviews/tasks?status=all&page=1&pageSize=20`);
  const history = await request(
    `${apiBase}/documents/${documentId}/reviews/history?status=all&page=1&pageSize=20`,
  );
  const statuses = history.items.map((item) => item.status);
  if (
    !statuses.includes('withdrawn') ||
    !statuses.includes('rejected') ||
    !statuses.includes('approved')
  ) {
    throw new Error(`Review history is incomplete: ${statuses.join(', ')}`);
  }
  if (!tasks.items.some((item) => item.id === approved.id)) {
    throw new Error('Review task list omitted the approved request');
  }

  await request(`${apiBase}/documents/${documentId}`, { method: 'DELETE' });
  await expectVersionVisibility(newMarker, second.documentVersionId, false);

  console.log(
    JSON.stringify(
      {
        documentId,
        firstVersionId: first.documentVersionId,
        secondVersionId: second.documentVersionId,
        withdrawnReviewId: withdrawn.id,
        rejectedReviewId: rejected.id,
        approvedReviewId: approved.id,
        draftHidden: true,
        pendingVersionHidden: true,
        oldPublishedVersionPreserved: true,
        approvedVersionPublished: true,
        archivedDocumentHidden: true,
        historyStatuses: statuses,
      },
      null,
      2,
    ),
  );
} finally {
  if (documentId) {
    await request(`${apiBase}/documents/${documentId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
}

async function uploadVersion({ documentId: existingDocumentId, title, filename, content }) {
  const bytes = Buffer.from(content);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      ...(existingDocumentId ? { documentId: existingDocumentId } : {}),
      title,
      sourceFilename: filename,
      mimeType: 'text/markdown',
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
    { method: 'POST', headers: jsonHeaders, body: '{}' },
  );
  await waitForReady(completed.jobId, completed.status);
  return created;
}

function publishVersion(targetDocumentId, versionId) {
  return request(`${apiBase}/documents/${targetDocumentId}/versions/${versionId}/publish`, {
    method: 'POST',
    headers: jsonHeaders,
    body: '{}',
  });
}

function submitReview(targetDocumentId, versionId, comment) {
  return request(`${apiBase}/documents/${targetDocumentId}/versions/${versionId}/reviews`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ comment }),
  });
}

async function expectVersionVisibility(marker, targetVersionId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await request(`${apiBase}/search`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ text: marker, page: 1, limit: 20 }),
    });
    const visible = result.hits.some((hit) => hit.documentVersionId === targetVersionId);
    if (visible === expected) return;
    await delay(250);
  }
  throw new Error(`Expected ${marker} version ${targetVersionId} visibility ${expected}`);
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

async function expectRequestStatus(url, init, expectedStatus) {
  const response = await fetch(url, init);
  if (response.status !== expectedStatus) {
    const body = await response.text();
    throw new Error(`Expected HTTP ${expectedStatus}, received ${response.status}: ${body}`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
