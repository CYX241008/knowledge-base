import { PDFParse } from 'pdf-parse';

export async function renderPdfPagePng(
  bytes: Uint8Array,
  pageNumber: number,
  desiredWidth = 1_400,
): Promise<Uint8Array> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError('PDF page number must be a positive integer');
  }
  const parser = new PDFParse({ data: bytes.slice() });
  try {
    const info = await parser.getInfo();
    if (pageNumber > info.total) {
      throw new RangeError(`PDF page ${pageNumber} exceeds the ${info.total}-page document`);
    }
    const result = await parser.getScreenshot({
      partial: [pageNumber],
      desiredWidth,
      imageBuffer: true,
      imageDataUrl: false,
    });
    const page = result.pages[0];
    if (!page?.data.byteLength) throw new Error(`PDF page ${pageNumber} could not be rendered`);
    return page.data;
  } finally {
    await parser.destroy();
  }
}
