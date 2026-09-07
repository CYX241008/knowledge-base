export const ASSET_SCHEME = 'knowledge-asset://';

export class ParserLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParserLimitError';
  }
}

export function assetReference(filename: string): string {
  return `${ASSET_SCHEME}${encodeURIComponent(filename)}`;
}

export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

export function toMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  if (width === 0) return '';

  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) => escapeTableCell(row[index] ?? '')),
  );
  const [header, ...body] = normalized;
  if (!header) return '';
  return [
    `| ${header.join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function sniffImageMimeType(bytes: Uint8Array, fallback = 'image/png'): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).startsWith('GIF8')) {
    return 'image/gif';
  }
  return fallback;
}

export function extensionForMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return extensions[mimeType.toLowerCase()] ?? 'bin';
}

export function imageDimensions(
  bytes: Uint8Array,
  mimeType = sniffImageMimeType(bytes, ''),
): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === 'image/png' && bytes.byteLength >= 24) {
    return positiveDimensions(view.getUint32(16), view.getUint32(20));
  }
  if (mimeType === 'image/gif' && bytes.byteLength >= 10) {
    return positiveDimensions(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (mimeType === 'image/jpeg') return jpegDimensions(bytes, view);
  if (
    mimeType === 'image/webp' &&
    bytes.byteLength >= 30 &&
    new TextDecoder().decode(bytes.slice(12, 16)) === 'VP8X'
  ) {
    return positiveDimensions(readUint24(bytes, 24) + 1, readUint24(bytes, 27) + 1);
  }
  return undefined;
}

export function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function jpegDimensions(
  bytes: Uint8Array,
  view: DataView,
): { width: number; height: number } | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + length + 2 > bytes.byteLength) return undefined;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return positiveDimensions(view.getUint16(offset + 7), view.getUint16(offset + 5));
    }
    offset += length + 2;
  }
  return undefined;
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function positiveDimensions(
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}
