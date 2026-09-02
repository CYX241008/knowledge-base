import { describe, expect, it, vi } from 'vitest';
import { ElasticsearchChunkIndex } from './elasticsearch';

describe('ElasticsearchChunkIndex', () => {
  it('pushes tenant and principal filters into keyword search', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hits: { hits: [{ _id: 'chunk-1', _score: 4.2 }] } }), {
          status: 200,
        }),
      );
    const index = new ElasticsearchChunkIndex('http://search:9200', 'chunks', fetcher);

    await expect(
      index.search('tenant-1', ['user-1', 'role-1'], 'vector search', 10, {
        spaceId: 'space-1',
        folderId: 'folder-1',
        tagIds: ['tag-1', 'tag-2'],
      }),
    ).resolves.toEqual([{ id: 'chunk-1', score: 4.2 }]);
    const request = fetcher.mock.calls[2];
    const body = JSON.parse(String(request?.[1]?.body)) as {
      query: { bool: { filter: unknown[] } };
    };
    expect(body.query.bool.filter).toEqual([
      { term: { tenant_id: 'tenant-1' } },
      { terms: { principal_ids: ['user-1', 'role-1'] } },
      { term: { document_status: 'published' } },
      { term: { space_id: 'space-1' } },
      { term: { folder_id: 'folder-1' } },
      { term: { tag_ids: 'tag-1' } },
      { term: { tag_ids: 'tag-2' } },
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toBe('http://search:9200/chunks/_mapping');
  });

  it('replaces every keyword chunk for a logical document', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: 2 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: false, items: [] }), { status: 200 }),
      );
    const index = new ElasticsearchChunkIndex('http://search:9200', 'chunks', fetcher);

    await index.replaceDocument('tenant-1', 'document-1', [
      {
        id: 'chunk-1',
        tenantId: 'tenant-1',
        principalIds: ['tenant-1'],
        documentId: 'document-1',
        documentVersionId: 'version-2',
        documentStatus: 'published',
        spaceId: null,
        folderId: null,
        tagIds: [],
        title: 'Published document',
        content: 'Published content',
        anchor: { type: 'document', offsetStart: 0, offsetEnd: 17 },
      },
    ]);

    const deleteBody = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(deleteBody.query.bool.filter).toEqual([
      { term: { tenant_id: 'tenant-1' } },
      { term: { document_id: 'document-1' } },
    ]);
    expect(String(fetcher.mock.calls[3]?.[1]?.body)).toContain('"document_status":"published"');
  });
});
