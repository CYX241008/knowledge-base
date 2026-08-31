import {
  AccessPrincipalIdSchema,
  type AccessPrincipalType,
  type IngestionStatus,
} from '@knowledge-base/contracts';

export { ingestionStatuses, type IngestionStatus } from '@knowledge-base/contracts';

const transitions: Record<IngestionStatus, readonly IngestionStatus[]> = {
  received: ['stored', 'failed', 'cancelled'],
  stored: ['parsing', 'retrying', 'failed', 'cancelled'],
  parsing: ['normalizing', 'retrying', 'failed', 'cancelled'],
  normalizing: ['chunking', 'retrying', 'failed', 'cancelled'],
  chunking: ['indexing', 'retrying', 'failed', 'cancelled'],
  indexing: ['ready', 'retrying', 'failed', 'cancelled'],
  ready: [],
  retrying: ['received', 'failed', 'cancelled'],
  failed: ['retrying'],
  cancelled: [],
};

export function canTransitionIngestionStatus(from: IngestionStatus, to: IngestionStatus): boolean {
  return transitions[from].includes(to);
}

export function assertIngestionTransition(from: IngestionStatus, to: IngestionStatus): void {
  if (!canTransitionIngestionStatus(from, to))
    throw new Error(`Invalid ingestion transition: ${from} -> ${to}`);
}

export type AccessPrincipal = { type: AccessPrincipalType; id: string };

export function parseAccessPrincipalId(value: string): AccessPrincipal | null {
  const parsed = AccessPrincipalIdSchema.safeParse(value);
  if (!parsed.success) return null;
  const separator = parsed.data.indexOf(':');
  return {
    type: parsed.data.slice(0, separator) as AccessPrincipalType,
    id: parsed.data.slice(separator + 1),
  };
}

export function uniqueAccessPrincipalIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => AccessPrincipalIdSchema.parse(value)))];
}

export function principalsOverlap(
  resourcePrincipalIds: readonly string[],
  subjectPrincipalIds: readonly string[],
): boolean {
  const subject = new Set(subjectPrincipalIds);
  return resourcePrincipalIds.some((principalId) => subject.has(principalId));
}
