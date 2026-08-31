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
      { term: { space_id: 'space-1' } },
      { term: { folder_id: 'folder-1' } },
      { term: { tag_ids: 'tag-1' } },
      { term: { tag_ids: 'tag-2' } },
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toBe('http://search:9200/chunks/_mapping');
  });
});
