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
  console.log(
    JSON.stringify(
      {
        sharedAcrossReplicas: true,
        allowedRequests: 2,
        rejectedRequests: 1,
        retryAfterMs: decisions[2].retryAfterMs,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([firstReplica.close(), secondReplica.close()]);
}
