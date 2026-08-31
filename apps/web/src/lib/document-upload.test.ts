import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_SIZE_BYTES,
  formatFileSize,
  titleFromFilename,
  validateDocumentFile,
} from './document-upload';

describe('document upload utilities', () => {
  it('accepts supported files within the configured limit', () => {
    expect(validateDocumentFile({ name: 'guide.md', size: 12 })).toBeNull();
    expect(validateDocumentFile({ name: 'notes.TXT', size: MAX_DOCUMENT_SIZE_BYTES })).toBeNull();
    expect(validateDocumentFile({ name: 'handbook.docx', size: 24 })).toBeNull();
    expect(validateDocumentFile({ name: 'report.PDF', size: 24 })).toBeNull();
    expect(validateDocumentFile({ name: 'metrics.xlsx', size: 24 })).toBeNull();
    expect(validateDocumentFile({ name: 'briefing.PPTX', size: 24 })).toBeNull();
  });

  it('rejects unsupported, empty, and oversized files', () => {
    expect(validateDocumentFile({ name: 'archive.zip', size: 12 })).toContain('DOCX');
    expect(validateDocumentFile({ name: 'empty.md', size: 0 })).toContain('不能为空');
    expect(validateDocumentFile({ name: 'large.md', size: MAX_DOCUMENT_SIZE_BYTES + 1 })).toContain(
      '50 MB',
    );
  });

  it('derives titles and readable sizes', () => {
    expect(titleFromFilename('engineering-guide.markdown')).toBe('engineering-guide');
    expect(titleFromFilename('quarterly-report.pdf')).toBe('quarterly-report');
    expect(titleFromFilename('quarterly-metrics.xlsx')).toBe('quarterly-metrics');
    expect(titleFromFilename('quarterly-briefing.pptx')).toBe('quarterly-briefing');
    expect(formatFileSize(753)).toBe('753 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });
});
