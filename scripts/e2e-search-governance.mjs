import { createHash, randomUUID } from 'node:crypto';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const elasticsearchUrl = process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200';
const elasticsearchIndex = process.env.ELASTICSEARCH_INDEX ?? 'knowledge-document-chunks-v1';
const jsonHeaders = { 'content-type': 'application/json' };
const keepData = process.env.E2E_KEEP_DATA === 'true';
const suffix = Date.now();
const marker = `search-governance-${suffix}`;
const sourceFilename = `search-governance-${suffix}.md`;
const content = Buffer.from(
  [
    '# Search governance acceptance',
    ...Array.from(
      { length: 180 },
      (_, index) =>
        `## Section ${index + 1}\n\n${marker} records searchable operational knowledge for pagination and governance acceptance. This paragraph intentionally supplies enough stable content to create multiple independently searchable chunks.`,
    ),
  ].join('\n\n'),
);
const sha256 = createHash('sha256').update(content).digest('hex');

let spaceId;
let folderId;
let tagId;
let documentId;

try {
  const session = await request(`${apiBase}/auth/me`);
  const tenantPrincipal = `tenant:${session.tenantId}`;
  const before = await request(`${apiBase}/search/governance?days=7`);

  ({ spaceId } = await request(`${apiBase}/knowledge/spaces`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      name: `Search Governance E2E ${suffix}`,
      description: '独立全文搜索与检索治理运行态验收',
      principalIds: [tenantPrincipal],
    }),
  }));
  ({ folderId } = await request(`${apiBase}/knowledge/folders`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ spaceId, parentId: null, name: '检索验收' }),
  }));
  ({ tagId } = await request(`${apiBase}/knowledge/tags`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: `治理-${suffix}`, color: '#1769aa', description: null }),
  }));

  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      title: `Search Governance E2E ${suffix}`,
      sourceFilename,
      mimeType: 'text/markdown',
      sizeBytes: content.byteLength,
      sha256,
      spaceId,
      folderId,
    }),
  });
  documentId = created.documentId;
  const upload = await fetch(created.uploadUrl, {
    method: 'PUT',
    headers: created.uploadHeaders,
    body: content,
  });
  if (!upload.ok) throw new Error(`Object upload failed with HTTP ${upload.status}`);
  const completed = await request(
    `${apiBase}/documents/${documentId}/versions/${created.documentVersionId}/complete`,
    { method: 'POST', headers: jsonHeaders, body: '{}' },
  );
  await waitForReady(completed.jobId, completed.status);
  await request(
    `${apiBase}/documents/${documentId}/versions/${created.documentVersionId}/publish`,
    { method: 'POST', headers: jsonHeaders, body: '{}' },
  );

  await request(`${apiBase}/knowledge/documents/${documentId}/tags`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ tagIds: [tagId] }),
  });
  await waitForElasticProjection({ spaceId, folderId, tagId });

  const firstPage = await search({ text: marker, page: 1, limit: 10 });
  const secondPage = await search({ text: marker, page: 2, limit: 10 });
  assertSearchEnvelope(firstPage, 1, 10);
  assertSearchEnvelope(secondPage, 2, 10);
  if (firstPage.total < 11)
    throw new Error(`Expected at least 11 ranked chunks, got ${firstPage.total}`);
  if (firstPage.total !== secondPage.total) {
    throw new Error(
      `Search total changed between pages: ${firstPage.total} then ${secondPage.total}`,
    );
  }
  if (firstPage.hits[0]?.chunkId === secondPage.hits[0]?.chunkId) {
    throw new Error('Page 1 and page 2 returned the same chunk');
  }
  assertFacet(firstPage.facets.spaces, spaceId, 'space');
  assertFacet(firstPage.facets.folders, folderId, 'folder');
  assertFacet(firstPage.facets.tags, tagId, 'tag');

  const zeroQuery = `no-result-${suffix}-unindexed`;
  const zeroResult = await search({
    text: zeroQuery,
    page: 1,
    limit: 10,
    spaceId: randomUUID(),
  });
  if (zeroResult.total !== 0 || zeroResult.hits.length !== 0) {
    throw new Error('Unique unindexed query should return zero results');
  }

  const after = await request(`${apiBase}/search/governance?days=7`);
  if (after.totalQueries < before.totalQueries + 3) {
    throw new Error('Governance total did not include all direct searches');
  }
  if (after.directSearchQueries < before.directSearchQueries + 3) {
    throw new Error('Governance direct-search count did not increase');
  }
  if (!after.noResultQueries.some((item) => item.query === zeroQuery)) {
    throw new Error('Zero-result query was not included in governance data');
  }
  if (!after.recentQueries.some((item) => item.query === marker && item.source === 'search')) {
    throw new Error('Recent governance queries did not include the successful search');
  }

  console.log(
    JSON.stringify(
      {
        documentId,
        marker,
        spaceId,
        folderId,
        tagId,
        paginationVerified: true,
        pageOneChunkId: firstPage.hits[0]?.chunkId,
        pageTwoChunkId: secondPage.hits[0]?.chunkId,
        totalRankedChunks: firstPage.total,
        facetsVerified: true,
        zeroResultRecorded: true,
        governanceQueryDelta: after.totalQueries - before.totalQueries,
        averageDurationMs: after.averageDurationMs,
        p95DurationMs: after.p95DurationMs,
      },
      null,
      2,
    ),
  );
} finally {
  if (keepData) {
    console.log('E2E_KEEP_DATA=true: retained search fixture for browser acceptance');
  } else {
    if (documentId) {
      await request(`${apiBase}/knowledge/documents/${documentId}/tags`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ tagIds: [] }),
      }).catch(() => undefined);
      await request(`${apiBase}/knowledge/documents/${documentId}/location`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ spaceId: null, folderId: null }),
      }).catch(() => undefined);
      await request(`${apiBase}/documents/${documentId}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
    if (tagId) {
      await request(`${apiBase}/knowledge/tags/${tagId}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
    if (folderId) {
      await request(`${apiBase}/knowledge/folders/${folderId}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
    if (spaceId) {
      await request(`${apiBase}/knowledge/spaces/${spaceId}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  }
}

function search(body) {
  return request(`${apiBase}/search`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

function assertSearchEnvelope(result, expectedPage, expectedPageSize) {
  if (
    result.page !== expectedPage ||
    result.pageSize !== expectedPageSize ||
    !Number.isInteger(result.total) ||
    !Number.isInteger(result.durationMs) ||
    !result.facets ||
    !Array.isArray(result.hits)
  ) {
    throw new Error(`Invalid paginated search response for page ${expectedPage}`);
  }
}

function assertFacet(values, id, name) {
  const facet = values.find((item) => item.id === id);
  if (!facet || facet.count < 1) throw new Error(`Search response omitted the ${name} facet`);
}

async function waitForReady(jobId, initialStatus) {
  if (initialStatus === 'ready') return;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const job = await request(`${apiBase}/ingestion/jobs/${jobId}`);
    if (job.status === 'completed') return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(job.errorMessage ?? `Ingestion ended with ${job.status}`);
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for document ingestion');
}

async function waitForElasticProjection(expected) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(
      `${elasticsearchUrl}/${encodeURIComponent(elasticsearchIndex)}/_search`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          size: 100,
          _source: ['space_id', 'folder_id', 'tag_ids'],
          query: { term: { document_id: documentId } },
        }),
      },
    );
    if (response.ok) {
      const body = await response.json();
      const hits = body.hits?.hits ?? [];
      if (
        hits.length > 1 &&
        hits.every(
          (hit) =>
            hit._source?.space_id === expected.spaceId &&
            hit._source?.folder_id === expected.folderId &&
            hit._source?.tag_ids?.includes(expected.tagId),
        )
      ) {
        return;
      }
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for Elasticsearch search-governance projection');
}

async function request(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const message = body?.error?.message ?? body?.message;
    throw new Error(
      typeof message === 'string' ? message : `Request failed with HTTP ${response.status}`,
    );
  }
  return body.data;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
