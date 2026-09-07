import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const jsonHeaders = { 'content-type': 'application/json' };
const suffix = Date.now();
const documents = [];
const conversationIds = new Set();
let spaceId;

const cases = [
  {
    key: 'text',
    title: `Format E2E TXT ${suffix}`,
    filename: `format-${suffix}.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(
      `Plain text acceptance ${suffix}.\n\nThe portable marker is txt-format-${suffix}.\n\nA final paragraph verifies offsets.`,
    ),
    searchText: `txt-format-${suffix}`,
    expectedSource: { type: 'document' },
    question: `What is the portable marker in Format E2E TXT ${suffix}? Show the document context.`,
    answerTerm: `txt-format-${suffix}`,
    expectedTools: ['read_location'],
  },
  {
    key: 'markdown',
    title: `Format E2E Markdown ${suffix}`,
    filename: `format-${suffix}.md`,
    mimeType: 'text/markdown',
    bytes: Buffer.from(
      `# Multi-format acceptance\n\n## Verification\n\nThe Markdown marker is md-format-${suffix}.\n\n| Stage | Status |\n| --- | --- |\n| Parse | Ready |`,
    ),
    searchText: `md-format-${suffix}`,
    expectedSource: { type: 'heading', heading: 'Verification' },
    question: `What is the marker in section: Verification? The document title is Format E2E Markdown ${suffix}.`,
    answerTerm: `md-format-${suffix}`,
    expectedTools: ['read_location'],
  },
  fixtureCase('docx', suffix, {
    title: `Format E2E DOCX ${suffix}`,
    filename: 'parser-sample.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    searchText: 'operations handbook',
    expectedSource: { type: 'heading', heading: 'Knowledge Base Guide' },
    question: `What should be read before publishing a document in Format E2E DOCX ${suffix}? Show the context.`,
    answerTerm: 'operations handbook',
    expectedTools: ['read_location'],
  }),
  fixtureCase('pdf', suffix, {
    title: `Format E2E PDF ${suffix}`,
    filename: 'parser-sample.pdf',
    mimeType: 'application/pdf',
    searchText: 'first page parser verification',
    expectedSource: { type: 'page', page: 1 },
    question: `What is page 1 used for in Format E2E PDF ${suffix}?`,
    answerTerm: 'parser verification',
    expectedTools: ['read_page'],
  }),
  fixtureCase('xlsx', suffix, {
    title: `Format E2E XLSX ${suffix}`,
    filename: 'parser-sample.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    searchText: 'Alpha 18 Operations',
    expectedSource: { type: 'sheet', sheet: 'Operations', range: 'A1:D5' },
    question: `In the Format E2E XLSX ${suffix} table, how many Alpha items are Ready in Operations!A1:D5?`,
    answerTerm: '18',
    expectedTools: ['read_range', 'get_table'],
  }),
  fixtureCase('pptx', suffix, {
    title: `Format E2E PPTX ${suffix}`,
    filename: 'parser-sample.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    searchText: 'retain this body text table below',
    expectedSource: { type: 'slide', slide: 2 },
    question: `What should slide 2 retain in Format E2E PPTX ${suffix}?`,
    answerTerm: 'table below',
    expectedTools: ['read_location'],
  }),
];

try {
  const session = await request(`${apiBase}/auth/me`);
  ({ spaceId } = await request(`${apiBase}/knowledge/spaces`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      name: `Multi-format E2E ${suffix}`,
      description: 'Structured parsing and citation acceptance',
      principalIds: [`tenant:${session.tenantId}`],
    }),
  }));

  for (const testCase of cases) {
    const bytes = await resolveBytes(testCase);
    const created = await uploadDocument(testCase, bytes, spaceId);
    documents.push({ ...testCase, ...created });
    const structure = await request(
      `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/structure`,
    );
    validateStructure(testCase.key, structure);
    await request(
      `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/publish`,
      { method: 'POST', headers: jsonHeaders, body: '{}' },
    );
  }

  const reports = [];
  for (const document of documents) {
    const search = await waitForSearchHit(document);
    const hit = search.hits.find((item) => item.documentId === document.documentId);
    assertSource(hit?.source, document.expectedSource, `${document.key} search`);

    const answer = await request(`${apiBase}/answers`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        question: document.question,
        limit: 8,
        includeDiagnostics: true,
      }),
    });
    conversationIds.add(answer.conversationId);
    if (!answer.grounded) throw new Error(`${document.key} answer was not grounded`);
    if (!normalize(answer.answer).includes(normalize(document.answerTerm))) {
      throw new Error(
        `${document.key} answer omitted ${document.answerTerm}: ${JSON.stringify({
          answer: answer.answer,
          citations: answer.citations.map((item) => ({
            documentId: item.documentId,
            title: item.title,
            source: item.source,
          })),
          toolCalls: answer.toolCalls,
        })}`,
      );
    }
    const citation = answer.citations.find((item) => item.documentId === document.documentId);
    if (!citation) throw new Error(`${document.key} answer omitted its document citation`);
    assertSource(citation.source, document.expectedSource, `${document.key} citation`);
    for (const toolName of document.expectedTools) {
      if (!answer.toolCalls.some((call) => call.name === toolName && call.status === 'success')) {
        throw new Error(
          `${document.key} answer did not complete ${toolName}: ${JSON.stringify(
            answer.toolCalls,
          )}`,
        );
      }
    }

    reports.push({
      format: document.key,
      documentId: document.documentId,
      versionId: document.documentVersionId,
      parser: `${document.parserName}@${document.parserVersion}`,
      source: citation.source,
      tools: answer.toolCalls.filter((call) => call.status === 'success').map((call) => call.name),
    });
  }

  console.log(
    JSON.stringify(
      {
        spaceId,
        formats: reports,
        uploadReady: true,
        structureVerified: true,
        searchVerified: true,
        answersGrounded: true,
        citationsVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
  for (const conversationId of conversationIds) {
    await request(`${apiBase}/answers/conversations/${conversationId}`, {
      method: 'DELETE',
    }).catch(() => undefined);
  }
  for (const document of documents) {
    await request(`${apiBase}/knowledge/documents/${document.documentId}/location`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ spaceId: null, folderId: null }),
    }).catch(() => undefined);
    await request(`${apiBase}/documents/${document.documentId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
  if (spaceId) {
    await request(`${apiBase}/knowledge/spaces/${spaceId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
}

function fixtureCase(key, runSuffix, options) {
  return {
    key,
    ...options,
    path: `packages/rag/test-fixtures/${options.filename}`,
    runSuffix,
  };
}

async function resolveBytes(testCase) {
  return testCase.bytes ?? readFile(resolve(testCase.path));
}

async function uploadDocument(testCase, bytes, targetSpaceId) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      title: testCase.title,
      sourceFilename: basename(testCase.filename),
      mimeType: testCase.mimeType ?? mimeTypeFor(testCase.filename),
      sizeBytes: bytes.byteLength,
      sha256,
      spaceId: targetSpaceId,
    }),
  });
  const upload = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: created.uploadHeaders,
    body: bytes,
  });
  if (!upload.ok)
    throw new Error(`${testCase.key} object upload failed with HTTP ${upload.status}`);
  const completed = await request(
    `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/complete`,
    { method: 'POST', headers: jsonHeaders, body: '{}' },
  );
  await waitForReady(completed);
  const detail = await request(`${apiBase}/documents/${created.documentId}`);
  const version = detail.versions.find((item) => item.id === created.documentVersionId);
  if (version?.ingestionStatus !== 'ready') {
    throw new Error(`${testCase.key} version did not become ready`);
  }
  return {
    ...created,
    parserName: version.parserName,
    parserVersion: version.parserVersion,
  };
}

async function waitForReady(completed) {
  if (completed.status === 'ready') return;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const job = await request(`${apiBase}/ingestion/jobs/${completed.jobId}`);
    if (job.status === 'completed') return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.errorMessage ?? `Ingestion ended with ${job.status}`);
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for document ingestion');
}

async function waitForSearchHit(testCase) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const search = await request(`${apiBase}/search`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        text: testCase.searchText,
        page: 1,
        limit: 20,
        spaceId,
      }),
    });
    if (search.hits.some((item) => item.documentId === testCase.documentId)) return search;
    await delay(250);
  }
  throw new Error(`${testCase.key} search projection did not become visible`);
}

function validateStructure(format, structure) {
  if (structure.version !== 2 || structure.format !== format) {
    throw new Error(`${format} returned an invalid structured document envelope`);
  }
  if (!structure.units.length || !structure.units.some((unit) => unit.elements.length > 0)) {
    throw new Error(`${format} structure did not contain elements`);
  }
  if (structure.quality.status !== 'pass') {
    throw new Error(`${format} fixture unexpectedly requires review`);
  }

  if (format === 'text' && !structure.units.some((unit) => unit.location.type === 'document')) {
    throw new Error('TXT structure omitted its document location');
  }
  if (
    format === 'markdown' &&
    !structure.units.some(
      (unit) => unit.location.type === 'section' && unit.location.heading === 'Verification',
    )
  ) {
    throw new Error('Markdown structure omitted the Verification section');
  }
  if (format === 'docx') {
    if (!structure.tables.length) throw new Error('DOCX structure omitted its table');
    if (!structure.units.some((unit) => unit.elements.some((element) => element.figureId))) {
      throw new Error('DOCX structure omitted its figure');
    }
  }
  if (
    format === 'pdf' &&
    !structure.units.some(
      (unit) =>
        unit.location.type === 'page' &&
        unit.location.page === 1 &&
        unit.elements.some((element) => element.bbox),
    )
  ) {
    throw new Error('PDF structure omitted page 1 coordinates');
  }
  if (
    format === 'xlsx' &&
    !structure.units.some(
      (unit) =>
        unit.location.type === 'sheet' &&
        unit.location.sheet === 'Operations' &&
        unit.location.range === 'A1:D5',
    )
  ) {
    throw new Error('XLSX structure omitted Operations!A1:D5');
  }
  if (
    format === 'pptx' &&
    !structure.units.some(
      (unit) =>
        unit.location.type === 'slide' &&
        unit.location.slide === 2 &&
        unit.elements.some((element) => element.bbox),
    )
  ) {
    throw new Error('PPTX structure omitted slide 2 coordinates');
  }
}

function assertSource(actual, expected, label) {
  if (!actual || actual.type !== expected.type) {
    throw new Error(
      `${label} source type was ${actual?.type ?? 'missing'}, expected ${expected.type}`,
    );
  }
  for (const key of ['page', 'slide', 'sheet', 'range', 'heading']) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) {
      throw new Error(`${label} source ${key} was ${actual[key]}, expected ${expected[key]}`);
    }
  }
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
    '.txt': 'text/plain',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return types[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function normalize(value) {
  return value.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
