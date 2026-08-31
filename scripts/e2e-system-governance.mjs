import { randomUUID } from 'node:crypto';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
const jsonHeaders = { 'content-type': 'application/json' };
const marker = `system-governance-${Date.now()}`;

let original;
let updated;

try {
  original = await request(`${apiBase}/admin/settings`);
  const beforeQuality = await request(`${apiBase}/admin/quality?days=7`);
  const candidateLimit = original.retrieval.candidateLimit === 120 ? 130 : 120;
  const defaultPageSize = original.retrieval.defaultPageSize === 7 ? 8 : 7;

  updated = await request(`${apiBase}/admin/settings`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({
      retrieval: {
        candidateLimit,
        scoreThreshold: original.retrieval.scoreThreshold,
        defaultPageSize,
        feedbackEnabled: true,
      },
      governance: original.governance,
    }),
  });
  if (updated.version <= original.version) throw new Error('Settings version did not increase');
  if (!updated.canEdit) throw new Error('Demo administrator unexpectedly cannot edit settings');

  const preferences = await request(`${apiBase}/search/preferences`);
  if (preferences.pageSize !== defaultPageSize || !preferences.feedbackEnabled) {
    throw new Error('Search preferences did not reflect the saved tenant settings');
  }

  const search = await request(`${apiBase}/search`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      text: marker,
      page: 1,
      limit: preferences.pageSize,
      spaceId: randomUUID(),
    }),
  });
  if (!search.queryEventId) throw new Error('Search response omitted its query event ID');
  if (search.total !== 0)
    throw new Error('Isolated acceptance query unexpectedly returned results');

  const feedback = await request(`${apiBase}/search/feedback`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      queryEventId: search.queryEventId,
      rating: 'unhelpful',
      reason: 'incomplete',
      comment: 'Fourth iteration runtime acceptance',
    }),
  });
  if (feedback.queryEventId !== search.queryEventId || feedback.rating !== 'unhelpful') {
    throw new Error('Search feedback response did not match the submitted event');
  }

  const afterQuality = await request(`${apiBase}/admin/quality?days=7`);
  if (afterQuality.search.totalQueries < beforeQuality.search.totalQueries + 1) {
    throw new Error('Quality metrics did not include the acceptance search');
  }
  if (afterQuality.feedback.total < beforeQuality.feedback.total + 1) {
    throw new Error('Quality metrics did not include the submitted feedback');
  }
  if (!afterQuality.feedback.reasons.some((item) => item.reason === 'incomplete')) {
    throw new Error('Feedback reason aggregation omitted the acceptance feedback');
  }

  const audit = await request(
    `${apiBase}/admin/audit?page=1&pageSize=30&action=system.settings.updated&resourceType=tenant`,
  );
  const event = audit.items.find((item) => item.metadata?.version === updated.version);
  if (!event) throw new Error('Settings update was not present in the audit log');

  console.log(
    JSON.stringify(
      {
        settingsVersion: updated.version,
        preferencesVerified: true,
        queryEventId: search.queryEventId,
        feedbackId: feedback.feedbackId,
        qualityQueryDelta: afterQuality.search.totalQueries - beforeQuality.search.totalQueries,
        qualityFeedbackDelta: afterQuality.feedback.total - beforeQuality.feedback.total,
        auditEventId: event.id,
        modelCallsInCurrentInstance: afterQuality.models.totalCalls,
        estimatedCostUsd: afterQuality.models.estimatedCostUsd,
      },
      null,
      2,
    ),
  );
} finally {
  if (original && updated) {
    await request(`${apiBase}/admin/settings`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({
        retrieval: original.retrieval,
        governance: original.governance,
      }),
    }).catch((error) => console.error(`Failed to restore original settings: ${error.message}`));
  }
}

async function request(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const message = body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;
    throw new Error(`${url}: ${typeof message === 'string' ? message : JSON.stringify(message)}`);
  }
  return body.data;
}
