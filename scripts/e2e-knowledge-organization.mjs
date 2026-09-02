import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const elasticsearchUrl = process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200';
const elasticsearchIndex = process.env.ELASTICSEARCH_INDEX ?? 'knowledge-document-chunks-v1';
const jsonHeaders = { 'content-type': 'application/json' };
const sourcePath = resolve('packages/rag/test-fixtures/search-sample.md');
const bytes = await readFile(sourcePath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const suffix = Date.now();

let spaceId;
let rootFolderId;
let childFolderId;
let topicTagId;
let reviewTagId;
let documentId;

try {
  const session = await request(`${apiBase}/auth/me`);
  const tenantPrincipal = `tenant:${session.tenantId}`;

  ({ spaceId } = await request(`${apiBase}/knowledge/spaces`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      name: `Iteration 2 E2E ${suffix}`,
      description: '知识空间、文件夹与标签运行态验收',
      principalIds: [tenantPrincipal],
    }),
  }));
  ({ folderId: rootFolderId } = await request(`${apiBase}/knowledge/folders`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ spaceId, parentId: null, name: '产品资料' }),
  }));
  ({ folderId: childFolderId } = await request(`${apiBase}/knowledge/folders`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ spaceId, parentId: rootFolderId, name: '检索规范' }),
  }));

  ({ tagId: topicTagId } = await request(`${apiBase}/knowledge/tags`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: `RAG-${suffix}`, color: '#1769aa', description: '检索主题' }),
  }));
  ({ tagId: reviewTagId } = await request(`${apiBase}/knowledge/tags`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ name: `已审核-${suffix}`, color: '#17845d', description: null }),
  }));

  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      title: `Knowledge Organization E2E ${suffix}`,
      sourceFilename: basename(sourcePath),
      mimeType: 'text/markdown',
      sizeBytes: bytes.byteLength,
      sha256,
      spaceId,
      folderId: childFolderId,
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
    body: JSON.stringify({ tagIds: [topicTagId, reviewTagId] }),
  });
  await waitForElasticProjection({
    spaceId,
    folderId: childFolderId,
    tagIds: [topicTagId, reviewTagId],
  });

  const overview = await request(`${apiBase}/knowledge/overview`);
  const childFolder = overview.folders.find((folder) => folder.id === childFolderId);
  const organizedDocument = overview.documents.find((document) => document.id === documentId);
  if (!childFolder?.principalIds.includes(tenantPrincipal)) {
    throw new Error('Child folder did not inherit the knowledge-space principal');
  }
  if (childFolder.directPrincipalIds.length !== 0) {
    throw new Error('New child folder should not materialize inherited ACL rows');
  }
  if (
    organizedDocument?.spaceId !== spaceId ||
    organizedDocument.folderId !== childFolderId ||
    organizedDocument.tagIds.length !== 2
  ) {
    throw new Error('Knowledge overview did not return the organized document metadata');
  }

  const filteredDocuments = await request(
    `${apiBase}/documents?page=1&pageSize=20&spaceId=${spaceId}&folderId=${childFolderId}&tagIds=${topicTagId},${reviewTagId}`,
  );
  if (!filteredDocuments.items.some((document) => document.id === documentId)) {
    throw new Error('Document-list organization filters did not return the target document');
  }

  await expectSearch(documentId, { spaceId, folderId: childFolderId, tagIds: [topicTagId] }, true);
  await expectSearch(documentId, { spaceId, folderId: rootFolderId, tagIds: [topicTagId] }, false);

  const cycleResponse = await fetch(`${apiBase}/knowledge/folders/${rootFolderId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ parentId: childFolderId }),
  });
  if (cycleResponse.status !== 409) {
    throw new Error(`Folder cycle should return 409, received ${cycleResponse.status}`);
  }

  await request(`${apiBase}/knowledge/tags/${reviewTagId}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ name: `复核完成-${suffix}`, color: '#0f766e' }),
  });

  await request(`${apiBase}/knowledge/documents/${documentId}/location`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ spaceId, folderId: rootFolderId }),
  });
  await waitForElasticProjection({
    spaceId,
    folderId: rootFolderId,
    tagIds: [topicTagId, reviewTagId],
  });
  await expectSearch(documentId, { spaceId, folderId: rootFolderId, tagIds: [reviewTagId] }, true);
  await expectSearch(documentId, { spaceId, folderId: childFolderId }, false);

  console.log(
    JSON.stringify(
      {
        spaceId,
        rootFolderId,
        childFolderId,
        documentId,
        inheritedAclVerified: true,
        folderCycleRejected: true,
        tagCrudVerified: true,
        documentMoveVerified: true,
        postgresFiltersVerified: true,
        elasticsearchProjectionVerified: true,
        filteredHybridSearchVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
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
  for (const tagId of [topicTagId, reviewTagId]) {
    if (tagId) {
      await request(`${apiBase}/knowledge/tags/${tagId}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  }
  for (const folderId of [childFolderId, rootFolderId]) {
    if (folderId) {
      await request(`${apiBase}/knowledge/folders/${folderId}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  }
  if (spaceId) {
    await request(`${apiBase}/knowledge/spaces/${spaceId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
}

async function expectSearch(targetDocumentId, filters, expected) {
  const result = await request(`${apiBase}/search`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ text: '量子凤梨索引', limit: 10, ...filters }),
  });
  const visible = result.hits.some((hit) => hit.documentId === targetDocumentId);
  if (visible !== expected) {
    throw new Error(`Expected filtered search visibility ${expected}, received ${visible}`);
  }
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

async function waitForElasticProjection(expected) {
  const sortedTags = [...expected.tagIds].sort();
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
        hits.length > 0 &&
        hits.every(
          (hit) =>
            hit._source?.space_id === expected.spaceId &&
            hit._source?.folder_id === expected.folderId &&
            JSON.stringify([...(hit._source?.tag_ids ?? [])].sort()) === JSON.stringify(sortedTags),
        )
      ) {
        return;
      }
    }
    await delay(250);
  }
  throw new Error('Timed out waiting for Elasticsearch organization projection');
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
