import { resolveSlackActor } from '../domain/authz';
import type { Actor } from '../types';

/** Thin re-export kept for call-site clarity inside slack/*.ts — always re-resolves from the
 * live Employee record, never trusts anything carried in the Slack payload. */
export async function getActorForSlackUser(slackUserId: string | undefined | null): Promise<Actor | null> {
  return resolveSlackActor(slackUserId);
}
