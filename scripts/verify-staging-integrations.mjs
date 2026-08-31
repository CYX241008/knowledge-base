const apiBase = required('STAGING_API_BASE_URL').replace(/\/$/u, '');
const primaryToken = required('STAGING_AUTH_TOKEN');

const health = await request(`${apiBase}/health`);
const primary = await request(`${apiBase}/auth/me`, primaryToken);
assertIdentity('primary', primary, {
  tenantId: process.env.STAGING_EXPECTED_TENANT_ID,
  userId: process.env.STAGING_EXPECTED_USER_ID,
  principals: list('STAGING_EXPECTED_PRINCIPALS'),
});

let roleChangeVerified = false;
if (process.env.STAGING_ROLE_CHANGED_AUTH_TOKEN) {
  const changed = await request(`${apiBase}/auth/me`, process.env.STAGING_ROLE_CHANGED_AUTH_TOKEN);
  assertIdentity('role-changed', changed, {
    tenantId: process.env.STAGING_EXPECTED_TENANT_ID,
    userId: process.env.STAGING_EXPECTED_USER_ID,
    principals: list('STAGING_CHANGED_EXPECTED_PRINCIPALS'),
  });
  roleChangeVerified = true;
}

let revokedTokenRejected = false;
if (process.env.STAGING_REVOKED_AUTH_TOKEN) {
  const response = await fetch(`${apiBase}/auth/me`, {
    headers: { authorization: `Bearer ${process.env.STAGING_REVOKED_AUTH_TOKEN}` },
  });
  if (response.status !== 401) {
    throw new Error(`Revoked token should return 401, received ${response.status}`);
  }
  revokedTokenRejected = true;
}

let crossTenantRejected = false;
if (process.env.STAGING_CROSS_TENANT_TOKEN && process.env.STAGING_FORBIDDEN_DOCUMENT_ID) {
  const response = await fetch(
    `${apiBase}/documents/${encodeURIComponent(process.env.STAGING_FORBIDDEN_DOCUMENT_ID)}`,
    { headers: { authorization: `Bearer ${process.env.STAGING_CROSS_TENANT_TOKEN}` } },
  );
  if (![403, 404].includes(response.status)) {
    throw new Error(
      `Cross-tenant document access should return 403/404, received ${response.status}`,
    );
  }
  crossTenantRejected = true;
}

const metrics = await request(`${apiBase}/metrics/models`, primaryToken);
const expectedOperations = list('STAGING_EXPECTED_MODEL_OPERATIONS');
if (expectedOperations.length === 0) expectedOperations.push('embedding', 'chat');
for (const operation of expectedOperations) {
  const metric = metrics.operations.find((item) => item.operation === operation);
  if (!metric?.success) throw new Error(`No successful ${operation} model readiness metric found`);
}

console.log(
  JSON.stringify(
    {
      apiBase,
      health: health.status,
      identityMode: primary.mode,
      tenantId: primary.tenantId,
      principalCount: primary.principalIds.length,
      roleChangeVerified,
      revokedTokenRejected,
      crossTenantRejected,
      modelOperations: metrics.operations.map((item) => ({
        operation: item.operation,
        model: item.model,
        success: item.success,
      })),
    },
    null,
    2,
  ),
);

async function request(url, token) {
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error?.message ?? `Request failed with HTTP ${response.status}`);
  }
  return body.data;
}

function assertIdentity(label, actual, expected) {
  if (actual.mode !== 'jwt') throw new Error(`${label} identity did not use JWT mode`);
  if (expected.tenantId && actual.tenantId !== expected.tenantId) {
    throw new Error(`${label} tenant mismatch`);
  }
  if (expected.userId && actual.userId !== expected.userId) {
    throw new Error(`${label} user mismatch`);
  }
  for (const principal of expected.principals) {
    if (!actual.principalIds.includes(principal)) {
      throw new Error(`${label} identity is missing expected principal ${principal}`);
    }
  }
}

function list(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
