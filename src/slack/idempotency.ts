import { claimIdempotencyKey, hashKey } from '../db/idempotency';

/**
 * Claims a one-time key derived from the raw Slack payload so a duplicated delivery (Slack
 * retry, double-click, slow network) of the same view submission or block action only ever
 * runs its side effects once. Returns true the first time; false on every duplicate.
 */
export async function claimSlackDelivery(scope: string, body: unknown): Promise<boolean> {
  const key = hashKey(scope, JSON.stringify(body));
  return claimIdempotencyKey('slack_delivery', key);
}
