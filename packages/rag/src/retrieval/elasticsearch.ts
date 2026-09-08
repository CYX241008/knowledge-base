import type { SourceAnchor } from '../index';

export const DEFAULT_DOCUMENT_CHUNK_INDEX = 'knowledge-document-chunks-v1';

export type KeywordIndexedChunk = {
  id: string;
  tenantId: string;
  principalIds: string[];
  documentId: string;
  documentVersionId: string;
  documentStatus: 'published';
  spaceId: string | null;
  folderId: string | null;
  tagIds: string[];
  title: string;
  content: string;
  contextSummary: string;
  anchor: SourceAnchor;
};

export type KeywordSearchHit = { id: string; score: number };

export type KeywordSearchFilters = {
  spaceId?: string;
  folderId?: string;
  tagIds?: string[];
};

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ElasticsearchChunkIndex {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly indexName = DEFAULT_DOCUMENT_CHUNK_INDEX,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async ensureIndex(): Promise<void> {
    const exists = await this.fetcher(this.url(''), { method: 'HEAD' });
    if (exists.ok) {
      await this.updateMapping();
      return;
    }
    if (exists.status !== 404) throw await elasticsearchError('check index', exists);
    const created = await this.fetcher(this.url(''), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mappings: {
          dynamic: 'strict',
          properties: indexProperties(),
        },
      }),
    });
    if (!created.ok) {
      const details = (await created.text()).slice(0, 1_000);
      if (created.status !== 400 || !details.includes('resource_already_exists_exception')) {
        throw new Error(`Failed to create index: Elasticsearch ${created.status} ${details}`);
      }
      await this.updateMapping();
    }
  }

  async replaceVersion(documentVersionId: string, chunks: KeywordIndexedChunk[]): Promise<void> {
    await this.ensureIndex();
    await this.deleteByQuery({ term: { document_version_id: documentVersionId } });
    await this.bulkIndex(chunks);
  }

  async replaceDocument(
    tenantId: string,
    documentId: string,
    chunks: KeywordIndexedChunk[],
  ): Promise<void> {
    await this.ensureIndex();
    await this.deleteByQuery({
      bool: {
        filter: [{ term: { tenant_id: tenantId } }, { term: { document_id: documentId } }],
      },
    });
    await this.bulkIndex(chunks);
  }

  private async bulkIndex(chunks: KeywordIndexedChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const body = chunks
      .flatMap((chunk) => [
        JSON.stringify({ index: { _index: this.indexName, _id: chunk.id } }),
        JSON.stringify({
          tenant_id: chunk.tenantId,
          principal_ids: chunk.principalIds,
          document_id: chunk.documentId,
          document_version_id: chunk.documentVersionId,
          document_status: chunk.documentStatus,
          space_id: chunk.spaceId,
          folder_id: chunk.folderId,
          tag_ids: chunk.tagIds,
          title: chunk.title,
          content: chunk.content,
          context_summary: chunk.contextSummary,
          anchor_type: chunk.anchor.type,
          page_no: chunk.anchor.page ?? null,
          slide_no: chunk.anchor.slide ?? null,
          sheet_name: chunk.anchor.sheet ?? null,
          row_start: chunk.anchor.rowStart ?? null,
          row_end: chunk.anchor.rowEnd ?? null,
          cell_range: chunk.anchor.range ?? null,
          heading: chunk.anchor.heading ?? null,
          element_type: chunk.anchor.elementType ?? null,
          element_ids: chunk.anchor.elementIds ?? [],
          section_path: chunk.anchor.sectionPath ?? [],
          table_id: chunk.anchor.tableId ?? null,
          figure_id: chunk.anchor.figureId ?? null,
          markdown_offset_start: chunk.anchor.offsetStart,
          markdown_offset_end: chunk.anchor.offsetEnd,
        }),
      ])
      .join('\n');
    const response = await this.fetcher(`${this.baseUrl}/_bulk?refresh=wait_for`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: `${body}\n`,
    });
    if (!response.ok) throw await elasticsearchError('bulk index chunks', response);
    const result = (await response.json()) as { errors?: boolean; items?: unknown[] };
    if (result.errors) throw new Error('Elasticsearch bulk index contained failed items');
  }

  async deleteDocument(tenantId: string, documentId: string): Promise<void> {
    await this.ensureIndex();
    await this.deleteByQuery({
      bool: {
        filter: [{ term: { tenant_id: tenantId } }, { term: { document_id: documentId } }],
      },
    });
  }

  async clear(tenantId?: string): Promise<void> {
    await this.ensureIndex();
    await this.deleteByQuery(tenantId ? { term: { tenant_id: tenantId } } : { match_all: {} });
  }

  async search(
    tenantId: string,
    principalIds: string[],
    text: string,
    limit: number,
    filters: KeywordSearchFilters = {},
  ): Promise<KeywordSearchHit[]> {
    return (await this.searchMany(tenantId, principalIds, [text], limit, filters))[0] ?? [];
  }

  async searchMany(
    tenantId: string,
    principalIds: string[],
    texts: string[],
    limit: number,
    filters: KeywordSearchFilters = {},
  ): Promise<KeywordSearchHit[][]> {
    await this.ensureIndex();
    return Promise.all(
      texts.map((text) => this.searchPrepared(tenantId, principalIds, text, limit, filters)),
    );
  }

  private async searchPrepared(
    tenantId: string,
    principalIds: string[],
    text: string,
    limit: number,
    filters: KeywordSearchFilters,
  ): Promise<KeywordSearchHit[]> {
    const filter: Record<string, unknown>[] = [
      { term: { tenant_id: tenantId } },
      { terms: { principal_ids: principalIds } },
      { term: { document_status: 'published' } },
    ];
    if (filters.spaceId) filter.push({ term: { space_id: filters.spaceId } });
    if (filters.folderId) filter.push({ term: { folder_id: filters.folderId } });
    for (const tagId of filters.tagIds ?? []) filter.push({ term: { tag_ids: tagId } });
    const response = await this.fetcher(this.url('_search'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        size: limit,
        _source: false,
        query: {
          bool: {
            must: [
              {
                multi_match: {
                  query: text,
                  fields: ['title^2', 'heading^1.5', 'context_summary^1.25', 'content'],
                },
              },
            ],
            filter,
          },
        },
      }),
    });
    if (!response.ok) throw await elasticsearchError('search chunks', response);
    const result = (await response.json()) as {
      hits?: { hits?: Array<{ _id: string; _score?: number | null }> };
    };
    return (result.hits?.hits ?? []).map((hit) => ({ id: hit._id, score: hit._score ?? 0 }));
  }

  private async deleteByQuery(query: Record<string, unknown>): Promise<void> {
    const response = await this.fetcher(
      this.url('_delete_by_query?refresh=true&conflicts=proceed'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      },
    );
    if (!response.ok) throw await elasticsearchError('delete chunks', response);
  }

  private async updateMapping(): Promise<void> {
    const response = await this.fetcher(this.url('_mapping'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ properties: indexProperties() }),
    });
    if (!response.ok) throw await elasticsearchError('update index mapping', response);
  }

  private url(path: string): string {
    return `${this.baseUrl}/${encodeURIComponent(this.indexName)}${path ? `/${path}` : ''}`;
  }
}

function indexProperties(): Record<string, { type: string }> {
  return {
    tenant_id: { type: 'keyword' },
    principal_ids: { type: 'keyword' },
    document_id: { type: 'keyword' },
    document_version_id: { type: 'keyword' },
    document_status: { type: 'keyword' },
    space_id: { type: 'keyword' },
    folder_id: { type: 'keyword' },
    tag_ids: { type: 'keyword' },
    title: { type: 'text' },
    content: { type: 'text' },
    context_summary: { type: 'text' },
    anchor_type: { type: 'keyword' },
    page_no: { type: 'integer' },
    slide_no: { type: 'integer' },
    sheet_name: { type: 'keyword' },
    row_start: { type: 'integer' },
    row_end: { type: 'integer' },
    cell_range: { type: 'keyword' },
    heading: { type: 'text' },
    element_type: { type: 'keyword' },
    element_ids: { type: 'keyword' },
    section_path: { type: 'keyword' },
    table_id: { type: 'keyword' },
    figure_id: { type: 'keyword' },
    markdown_offset_start: { type: 'integer' },
    markdown_offset_end: { type: 'integer' },
  };
}

async function elasticsearchError(action: string, response: Response): Promise<Error> {
  const details = (await response.text()).slice(0, 1_000);
  return new Error(`Failed to ${action}: Elasticsearch ${response.status} ${details}`);
}
