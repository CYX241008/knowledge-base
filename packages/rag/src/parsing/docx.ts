import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { DocumentParser, ParsedAsset, ParseInput, ParseResult } from '../index';
import { cleanMarkdown, extensionOf, headingAnchors } from './plain-text';
import { assetReference, extensionForMimeType, toMarkdownTable, withTimeout } from './parser-utils';

const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 500;
const PARSE_TIMEOUT_MS = 60_000;

export class DocxDocumentParser implements DocumentParser {
  readonly name = 'mammoth-turndown';
  readonly version = '1.0.0';

  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean {
    const extension = extensionOf(input.filename);
    return extension
      ? extension === 'docx'
      : input.mimeType.toLowerCase() ===
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.supports(input)) throw new Error('Unsupported DOCX format');
    if (input.bytes.byteLength === 0) throw new Error('DOCX file is empty');

    const assets: ParsedAsset[] = [];
    const warnings: string[] = [];
    let totalImageBytes = 0;
    let imageOrdinal = 0;
    const result = await withTimeout(
      mammoth.convertToHtml(
        { buffer: Buffer.from(input.bytes) },
        {
          styleMap: [
            "p[style-name='Title'] => h1:fresh",
            "p[style-name='Subtitle'] => h2:fresh",
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
            "p[style-name='Heading 4'] => h4:fresh",
            "p[style-name='标题 1'] => h1:fresh",
            "p[style-name='标题 2'] => h2:fresh",
            "p[style-name='标题 3'] => h3:fresh",
            "p[style-name='标题 4'] => h4:fresh",
          ],
          convertImage: mammoth.images.imgElement(async (image) => {
            imageOrdinal += 1;
            try {
              if (imageOrdinal > MAX_EMBEDDED_IMAGES) {
                warnings.push('Skipped remaining DOCX images: document exceeds 500 images');
                return { src: '' };
              }
              const buffer = await image.readAsBuffer();
              if (buffer.byteLength > MAX_EMBEDDED_IMAGE_BYTES) {
                warnings.push(`Skipped DOCX image ${imageOrdinal}: image exceeds 10 MB`);
                return { src: '' };
              }
              if (totalImageBytes + buffer.byteLength > MAX_TOTAL_IMAGE_BYTES) {
                warnings.push(`Skipped DOCX image ${imageOrdinal}: total image data exceeds 50 MB`);
                return { src: '' };
              }

              totalImageBytes += buffer.byteLength;
              const mimeType = image.contentType || 'application/octet-stream';
              const filename = `docx-image-${String(imageOrdinal).padStart(3, '0')}.${extensionForMimeType(mimeType)}`;
              assets.push({
                kind: 'image',
                filename,
                mimeType,
                bytes: new Uint8Array(buffer),
              });
              return { src: assetReference(filename) };
            } catch (error) {
              warnings.push(`Skipped DOCX image ${imageOrdinal}: ${errorMessage(error)}`);
              return { src: '' };
            }
          }),
        },
      ),
      PARSE_TIMEOUT_MS,
      'DOCX parsing timed out after 60 seconds',
    );

    warnings.push(...result.messages.map((message) => message.message));
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
    turndown.use(gfm);
    turndown.addRule('word-table', {
      filter: 'table',
      replacement: (_content, node) => {
        const table = node as HTMLTableElement;
        const rows = Array.from(table.rows).map((row) =>
          Array.from(row.cells).map((cell) => cell.textContent?.trim() ?? ''),
        );
        const markdown = toMarkdownTable(rows);
        return markdown ? `\n\n${markdown}\n\n` : '';
      },
    });

    const markdown = cleanMarkdown(turndown.turndown(result.value));
    if (!markdown) throw new Error('Parsed DOCX document is empty');
    return {
      markdown,
      anchors: headingAnchors(markdown),
      assets,
      warnings,
      stats: { characters: markdown.length },
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
