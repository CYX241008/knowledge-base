import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const tenantId = process.env.NEXT_PUBLIC_DEMO_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const sourcePath = resolve(process.argv[2] ?? 'packages/rag/test-fixtures/search-sample.md');
const marker = `rag-grounded-${Date.now()}`;
const bytes = Buffer.concat([
  await readFile(sourcePath),
  Buffer.from(
    `\n\n## Unique grounded marker\n\n${marker} verifies grounded citation persistence for this evaluation run.\n`,
  ),
]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
let documentId;
const conversationIds = new Set();

try {
  const forbidden = await fetch(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Forbidden ACL check',
      sourceFilename: basename(sourcePath),
      mimeType: 'text/markdown',
      sizeBytes: bytes.byteLength,
      sha256,
      principalIds: ['role:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    }),
  });
  if (forbidden.status !== 400) {
    throw new Error(`Unknown document principal should return 400, received ${forbidden.status}`);
  }

  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: `Phase 7 Grounded Answer E2E ${marker}`,
      sourceFilename: basename(sourcePath),
      mimeType: 'text/markdown',
      sizeBytes: bytes.byteLength,
      sha256,
      principalIds: [`tenant:${tenantId}`],
    }),
  });
  documentId = created.documentId;

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
      body: JSON.stringify({ tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    },
  );
  await waitForReady(completed);
  await request(
    `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/publish`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  );

  const grounded = await streamAnswer(`What does ${marker} verify?`);
  if (!grounded.grounded) throw new Error('Relevant question was not marked as grounded');
  if (!grounded.answer.includes('[1]')) throw new Error('Grounded answer has no citation marker');
  if (!grounded.citations.some((citation) => citation.documentId === created.documentId)) {
    throw new Error('Grounded answer did not cite the uploaded document');
  }

  const refused = await streamAnswer('zxqvnomatch20260730');
  if (refused.grounded || refused.citations.length !== 0) {
    throw new Error('Unrelated question should not return evidence');
  }
  if (!refused.answer.includes('没有足够证据')) {
    throw new Error('Unrelated question did not use the refusal response');
  }

  const conversations = await request(`${apiBase}/answers/conversations?page=1&pageSize=30`);
  if (
    !conversationIds.has(grounded.conversationId) ||
    !conversationIds.has(refused.conversationId)
  ) {
    throw new Error('Answer stream did not return conversation identifiers');
  }
  if (
    ![grounded.conversationId, refused.conversationId].every((id) =>
      conversations.items.some((item) => item.id === id),
    )
  ) {
    throw new Error('Conversation list did not include the generated answers');
  }
  const history = await request(`${apiBase}/answers/conversations/${grounded.conversationId}`);
  if (history.messages.length !== 2) {
    throw new Error(`Expected two persisted messages, received ${history.messages.length}`);
  }
  const userMessage = history.messages.find((message) => message.role === 'user');
  const assistantMessage = history.messages.find((message) => message.role === 'assistant');
  if (
    !grounded.runId ||
    userMessage?.answerRun?.id !== grounded.runId ||
    userMessage.answerRun.status !== 'completed' ||
    userMessage.answerRun.assistantMessageId !== assistantMessage?.id
  ) {
    throw new Error('Conversation history did not preserve the completed answer run');
  }
  if (!assistantMessage?.citations.some((citation) => citation.documentId === created.documentId)) {
    throw new Error('Conversation history did not preserve the answer citation');
  }
  await request(`${apiBase}/answers/conversations/${refused.conversationId}`, {
    method: 'DELETE',
  });
  conversationIds.delete(refused.conversationId);
  const deletedConversation = await fetch(
    `${apiBase}/answers/conversations/${refused.conversationId}`,
  );
  if (deletedConversation.status !== 404) {
    throw new Error(
      `Deleted conversation should return 404, received ${deletedConversation.status}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        documentId: created.documentId,
        marker,
        forgedAclRejected: true,
        clientIdentityIgnored: true,
        grounded: grounded.grounded,
        citationCount: grounded.citations.length,
        citationDocumentId: grounded.citations[0]?.documentId,
        refused: !refused.grounded,
        refusalCitationCount: refused.citations.length,
        conversationHistoryPersisted: true,
        answerRunPersisted: true,
        conversationDeleteVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
  for (const conversationId of conversationIds) {
    await request(`${apiBase}/answers/conversations/${conversationId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
  if (documentId) {
    await request(`${apiBase}/documents/${documentId}?tenantId=${tenantId}`, { method: 'DELETE' });
  }
}

async function waitForReady(completed) {
  if (completed.status === 'ready') return;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const job = await request(`${apiBase}/ingestion/jobs/${completed.jobId}?tenantId=${tenantId}`);
    if (job.status === 'completed') return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.errorMessage ?? `Ingestion ended with ${job.status}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('Timed out waiting for document ingestion');
}

async function streamAnswer(question) {
  const response = await fetch(`${apiBase}/answers/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      principalIds: ['role:forged-client-principal'],
      question,
      limit: 6,
    }),
  });
  if (!response.ok || !response.body) throw new Error(`Answer failed with HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/u);
    buffer = frames.pop() ?? '';
    for (const frame of frames) result = consumeFrame(frame, result);
    if (done) break;
  }
  if (buffer.trim()) result = consumeFrame(buffer, result);
  if (!result) throw new Error('Answer stream ended without a done event');
  conversationIds.add(result.conversationId);
  return result;
}

function consumeFrame(frame, current) {
  const eventName = frame.match(/^event:\s*(.+)$/mu)?.[1]?.trim();
  const data = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return current;
  const payload = JSON.parse(data);
  if (eventName === 'error') throw new Error(payload.message ?? 'Answer stream failed');
  return eventName === 'done' ? payload.response : current;
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
