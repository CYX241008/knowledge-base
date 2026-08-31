import JSZip from 'jszip';
import { ParserLimitError, withTimeout } from './parser-utils';

const MAX_OFFICE_ENTRIES = 10_000;
const MAX_OFFICE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_OFFICE_COMPRESSION_RATIO = 200;
const PACKAGE_TIMEOUT_MS = 60_000;

type ZipEntryWithSizes = JSZip.JSZipObject & {
  _data?: { compressedSize?: number; uncompressedSize?: number };
};

export async function loadOfficePackage(bytes: Uint8Array, format: string): Promise<JSZip> {
  const zip = await withTimeout(
    JSZip.loadAsync(bytes),
    PACKAGE_TIMEOUT_MS,
    `${format} package loading timed out after 60 seconds`,
  );
  const entries = Object.values(zip.files);
  if (entries.length > MAX_OFFICE_ENTRIES) {
    throw new ParserLimitError(`${format} exceeds the ${MAX_OFFICE_ENTRIES}-entry package limit`);
  }
  if (!zip.file('[Content_Types].xml')) throw new Error(`${format} is not a valid OOXML package`);

  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const data = (entry as ZipEntryWithSizes)._data;
    const uncompressedSize = data?.uncompressedSize;
    const compressedSize = data?.compressedSize;
    if (typeof uncompressedSize !== 'number') continue;
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_OFFICE_UNCOMPRESSED_BYTES) {
      throw new ParserLimitError(`${format} package expands beyond 200 MB`);
    }
    if (
      typeof compressedSize === 'number' &&
      compressedSize > 0 &&
      uncompressedSize / compressedSize > MAX_OFFICE_COMPRESSION_RATIO
    ) {
      throw new ParserLimitError(`${format} package contains an unsafe compression ratio`);
    }
  }
  return zip;
}

export async function readZipText(
  file: JSZip.JSZipObject,
  format: string,
  maximumBytes: number,
): Promise<string> {
  const bytes = await withTimeout(
    file.async('uint8array'),
    PACKAGE_TIMEOUT_MS,
    `${format} package entry extraction timed out after 60 seconds`,
  );
  if (bytes.byteLength > maximumBytes) {
    throw new ParserLimitError(`${format} package entry exceeds ${maximumBytes} bytes`);
  }
  return new TextDecoder().decode(bytes);
}
