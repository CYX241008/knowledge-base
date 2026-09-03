import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const elasticsearchUrl = process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200';
const elasticsearchIndex = process.env.ELASTICSEARCH_INDEX ?? 'knowledge-document-chunks-v1';
const sourcePath = resolve('packages/rag/test-fixtures/search-sample.md');
const searchMarker = `aclmarker${Date.now()}`;
const bytes = Buffer.concat([
  await readFile(sourcePath),
  Buffer.from(`\n\n## Access marker\n\n${searchMarker}\n`),
]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const roleName = `ACL E2E ${Date.now()}`;
let roleId;
let documentId;

try {
  const session = await request(`${apiBase}/auth/me`);
  const systemRoleIds = session.principalIds
    .filter((principalId) => principalId.startsWith('role:'))
    .map((principalId) => principalId.slice(5));

  ({ roleId } = await request(`${apiBase}/access/roles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: roleName,
      description: '运行态访问控制验收角色',
      permissionKeys: [],
    }),
  }));
  await assignRoles(session.userId, [...systemRoleIds, roleId]);

  const rolePrincipal = `role:${roleId}`;
  const roleSession = await request(`${apiBase}/auth/me`);
  if (!roleSession.principalIds.includes(rolePrincipal)) {
    throw new Error('Assigned role was not expanded into the authenticated principal set');
  }

  const created = await request(`${apiBase}/documents/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Access Control E2E',
      sourceFilename: basename(sourcePath),
      mimeType: 'text/markdown',
      sizeBytes: bytes.byteLength,
      sha256,
      principalIds: [rolePrincipal],
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
      body: '{}',
    },
  );
  await waitForReady(completed.jobId, completed.status);
  await request(
    `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/publish`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );

  await waitForElasticPrincipals(documentId, [rolePrincipal]);
  await expectSearchVisibility(documentId, true);
  await assignRoles(session.userId, systemRoleIds);
  await expectSearchVisibility(documentId, false);

  const userPrincipal = `user:${session.userId}`;
  const userAcl = await replaceAcl(documentId, [userPrincipal]);
  await waitForElasticPrincipals(documentId, [userPrincipal]);
  await expectSearchVisibility(documentId, true);

  const restrictedAcl = await replaceAcl(documentId, [rolePrincipal]);
  if (restrictedAcl.aclVersion <= userAcl.aclVersion) {
    throw new Error('Document ACL version did not increase monotonically');
  }
  await waitForElasticPrincipals(documentId, [rolePrincipal]);
  await expectSearchVisibility(documentId, false);

  const directRead = await fetch(`${apiBase}/documents/${documentId}`);
  if (directRead.status !== 403) {
    throw new Error(
      `Revoked direct document read should return 403, received ${directRead.status}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        documentId,
        roleId,
        roleExpandedIntoSession: true,
        roleRestrictedUpload: true,
        revokedSearchHidden: true,
        postgresAclProjected: true,
        elasticsearchAclProjected: true,
        directReadRevoked: true,
        finalAclVersion: restrictedAcl.aclVersion,
      },
      null,
      2,
    ),
  );
} finally {
  const session = await request(`${apiBase}/auth/me`).catch(() => null);
  if (documentId && session) {
    await replaceAcl(documentId, [`tenant:${session.tenantId}`]).catch(() => undefined);
    await request(`${apiBase}/documents/${documentId}`, { method: 'DELETE' }).catch(
      () => undefined,
    );
  }
  if (roleId) {
    await request(`${apiBase}/access/roles/${roleId}`, { method: 'DELETE' }).catch(() => undefined);
  }
}

async function assignRoles(userId, roleIds) {
  return request(`${apiBase}/access/members/${userId}/roles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleIds }),
  });
}

async function replaceAcl(targetDocumentId, principalIds) {
  return request(`${apiBase}/access/documents/${targetDocumentId}/acl`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grants: principalIds.map((principalId) => ({
        principalId,
        permissions: ['documents.read'],
      })),
    }),
  });
}

async function expectSearchVisibility(targetDocumentId, expected) {
  const result = await request(`${apiBase}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: searchMarker, limit: 10 }),
  });
  const visible = result.hits.some((hit) => hit.documentId === targetDocumentId);
  if (visible !== expected) {
    throw new Error(
      `Expected search visibility ${expected}, received ${visible}; hits=${JSON.stringify(
        result.hits.map((hit) => ({
          documentId: hit.documentId,
          title: hit.title,
          score: hit.score,
        })),
      )}`,
    );
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

async function waitForElasticPrincipals(targetDocumentId, expectedPrincipalIds) {
  const expected = [...expectedPrincipalIds].sort();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(
      `${elasticsearchUrl}/${encodeURIComponent(elasticsearchIndex)}/_search`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          size: 100,
          _source: ['principal_ids'],
          query: { term: { document_id: targetDocumentId } },
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
            JSON.stringify([...(hit._source?.principal_ids ?? [])].sort()) ===
            JSON.stringify(expected),
        )
      ) {
        return;
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Elasticsearch ACL projection on ${targetDocumentId}`);
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
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
