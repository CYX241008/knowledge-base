import { randomUUID } from 'node:crypto';
import { RedisModelRateLimiter } from '../packages/model-gateway/dist/index.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const namespace = `knowledge-base-e2e-${randomUUID()}`;
const firstReplica = new RedisModelRateLimiter({ url: redisUrl, namespace, windowMs: 2_000 });
const secondReplica = new RedisModelRateLimiter({ url: redisUrl, namespace, windowMs: 2_000 });
const input = { operation: 'chat', model: 'shared-quota-model', limit: 2 };

try {
  const decisions = [
    await firstReplica.consume(input),
    await secondReplica.consume(input),
    await firstReplica.consume(input),
  ];
  if (!decisions[0]?.allowed || !decisions[1]?.allowed || decisions[2]?.allowed) {
    throw new Error(`Unexpected global quota decisions: ${JSON.stringify(decisions)}`);
  }
  const tokenInput = {
    operation: 'chat',
    model: 'shared-token-model',
    limit: 0,
    estimatedTokens: 700,
    tokenLimits: {
      global: 10_000,
      tenant: 1_000,
      user: 0,
      model: { chat: 5_000 },
    },
    context: { tenantId: '11111111-1111-4111-8111-111111111111' },
  };
  const firstTokenDecision = await firstReplica.consume(tokenInput);
  const rejectedTokenDecision = await secondReplica.consume(tokenInput);
  if (!firstTokenDecision.allowed || rejectedTokenDecision.allowed) {
    throw new Error(
      `Unexpected shared TPM quota decisions: ${JSON.stringify([
        firstTokenDecision,
        rejectedTokenDecision,
      ])}`,
    );
  }
  if (!firstTokenDecision.reservation) throw new Error('Expected a TPM reservation');
  await firstReplica.settle(firstTokenDecision.reservation, 200);
  const settledTokenDecision = await secondReplica.consume(tokenInput);
  if (!settledTokenDecision.allowed) {
    throw new Error(
      `TPM settlement did not release quota: ${JSON.stringify(settledTokenDecision)}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        sharedAcrossReplicas: true,
        allowedRequests: 2,
        rejectedRequests: 1,
        retryAfterMs: decisions[2].retryAfterMs,
        sharedTokenQuota: true,
        tokenReservationSettled: true,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([firstReplica.close(), secondReplica.close()]);
}
