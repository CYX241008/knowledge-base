import { describe, expect, it } from 'vitest';
import { isPublishedSearchVersion } from './search-projection.service';

describe('published search projection boundary', () => {
  const oldVersionId = '11111111-1111-4111-8111-111111111111';
  const pendingVersionId = '22222222-2222-4222-8222-222222222222';

  it('does not expose a ready draft version', () => {
    expect(
      isPublishedSearchVersion(
        { status: 'draft', currentReadyVersionId: pendingVersionId },
        pendingVersionId,
      ),
    ).toBe(false);
  });

  it('keeps the old published version visible while a new version is pending review', () => {
    const document = { status: 'published' as const, currentReadyVersionId: oldVersionId };
    expect(isPublishedSearchVersion(document, oldVersionId)).toBe(true);
    expect(isPublishedSearchVersion(document, pendingVersionId)).toBe(false);
  });

  it('does not expose an archived document', () => {
    expect(
      isPublishedSearchVersion(
        { status: 'archived', currentReadyVersionId: oldVersionId },
        oldVersionId,
      ),
    ).toBe(false);
  });
});
