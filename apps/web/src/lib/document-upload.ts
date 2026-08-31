export const MAX_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024;

const supportedExtensions = new Set(['txt', 'md', 'markdown', 'docx', 'pdf', 'xlsx', 'pptx']);

export function validateDocumentFile(file: Pick<File, 'name' | 'size'>): string | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!supportedExtensions.has(extension))
    return '当前支持 TXT、Markdown、DOCX、PDF、XLSX 和 PPTX 文件';
  if (file.size === 0) return '文件内容不能为空';
  if (file.size > MAX_DOCUMENT_SIZE_BYTES) return '文件不能超过 50 MB';
  return null;
}

export function titleFromFilename(filename: string): string {
  return filename.replace(/\.(?:txt|md|markdown|docx|pdf|xlsx|pptx)$/i, '').trim() || '未命名文档';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
