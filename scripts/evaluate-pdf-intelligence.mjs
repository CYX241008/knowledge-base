import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PdfDocumentParser, evaluatePdfStructure } from '../packages/rag/dist/index.js';

const dataset = JSON.parse(
  await readFile(resolve('packages/rag/test-fixtures/pdf-intelligence-evaluation.json'), 'utf8'),
);
const reports = [];
for (const document of dataset.documents) {
  const bytes = new Uint8Array(await readFile(resolve(document.path)));
  const parsed = await new PdfDocumentParser().parse({
    filename: document.path,
    mimeType: 'application/pdf',
    bytes,
  });
  reports.push({
    path: document.path,
    ...evaluatePdfStructure(parsed.structure, document.cases),
  });
}
console.log(JSON.stringify(reports, null, 2));
if (reports.some((report) => !report.passed)) process.exitCode = 1;
