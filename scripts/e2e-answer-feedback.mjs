import { createHash } from 'node:crypto';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const headers = { 'content-type': 'application/json' };
const marker = `answer-feedback-${Date.now()}`;
let documentId;
let conversationId;

try {
  const qualityBefore = await request(`${apiBase}/admin/quality?days=7`);
  const created = await uploadDocument();
  documentId = created.documentId;
  await publishVersion(created.documentId, created.documentVersionId);

  const answer = await request(`${apiBase}/answers`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question: `${marker} 表示什么？`,
      limit: 6,
    }),
  });
  conversationId = answer.conversationId;
  if (!answer.grounded || answer.citations.length === 0) {
    throw new Error('Expected a grounded answer before submitting feedback');
  }

  const feedback = await request(`${apiBase}/answers/${answer.runId}/feedback`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      rating: 'unhelpful',
      reason: 'incomplete',
      comment: 'E2E feedback candidate',
    }),
  });
  const conversation = await request(`${apiBase}/answers/conversations/${answer.conversationId}`);
  const persistedRun = conversation.messages
    .map((message) => message.answerRun)
    .find((run) => run?.id === answer.runId);
  if (
    persistedRun?.feedback?.feedbackId !== feedback.feedbackId ||
    persistedRun.feedback.reason !== 'incomplete'
  ) {
    throw new Error('Conversation did not restore the submitted answer feedback');
  }

  const qualityAfter = await request(`${apiBase}/admin/quality?days=7`);
  if (qualityAfter.answerFeedback.total < qualityBefore.answerFeedback.total + 1) {
    throw new Error('Quality governance did not include the answer feedback');
  }
  const candidates = await request(`${apiBase}/admin/evaluation-candidates?days=7&limit=100`);
  const candidate = candidates.items.find((item) => item.feedbackId === feedback.feedbackId);
  if (!candidate || candidate.question !== `${marker} 表示什么？`) {
    throw new Error('Evaluation candidate export omitted the unhelpful answer');
  }

  console.log(
    JSON.stringify(
      {
        documentId,
        conversationId,
        runId: answer.runId,
        feedbackId: feedback.feedbackId,
        answerFeedbackDelta: qualityAfter.answerFeedback.total - qualityBefore.answerFeedback.total,
        candidateExported: true,
        citationCount: candidate.citations.length,
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
  const content = `# Answer feedback evaluation\n\n${marker} means the production answer feedback loop is working.`;
  const bytes = Buffer.from(content);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: `Answer Feedback E2E ${marker}`,
      sourceFilename: `${marker}.md`,
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
