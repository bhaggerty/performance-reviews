import { Router } from 'express';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { config } from '../config';
import { logger } from '../logger';

const router = Router();
const client = new DynamoDBClient({ region: config.aws.region, ...(config.aws.endpoint ? { endpoint: config.aws.endpoint } : {}) });

let shuttingDown = false;
export function markShuttingDown(): void {
  shuttingDown = true;
}

/**
 * Union Station polls this for liveness (per the sibling apps' documented convention —
 * see the `reference_union_station` project note). Deliberately cheap: confirms the process is
 * up and not draining, without a live AWS round-trip, so this endpoint can never be slowed down
 * or exhausted by a DynamoDB-side issue. This is the endpoint Union Station's service health
 * check should be pointed at.
 */
router.get('/health', (_req, res) => {
  if (shuttingDown) {
    res.status(503).json({ status: 'shutting_down' });
    return;
  }
  res.status(200).json({ status: 'ok' });
});

// Alias kept for any generic k8s-style monitor that expects this specific path.
router.get('/health/live', (_req, res) => {
  if (shuttingDown) {
    res.status(503).json({ status: 'shutting_down' });
    return;
  }
  res.status(200).json({ status: 'ok' });
});

/** Heavier readiness check (does a live DescribeTable round-trip) — not what Union Station
 * itself polls, but useful for an internal load balancer / ECS target group that wants a
 * dependency-aware check rather than the deliberately-cheap /health. */
router.get('/health/ready', async (_req, res) => {
  if (shuttingDown) {
    res.status(503).json({ status: 'shutting_down' });
    return;
  }
  try {
    await client.send(new DescribeTableCommand({ TableName: config.aws.tableName }));
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    logger.error('Readiness check failed', { error: error instanceof Error ? error.name : 'unknown' });
    res.status(503).json({ status: 'not_ready' });
  }
});

export default router;
