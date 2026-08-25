export interface ReviewCoachInput {
  flow: 'manager_review' | 'peer_feedback' | 'upward_feedback';
  subjectName: string;
  cycleName: string;
  status?: string;
  answers: Array<{ label: string; value?: string }>;
}

export interface ReviewCoachResult {
  needsFollowup: boolean;
  questions: string[];
}

export interface UpwardSummaryInput {
  managerName: string;
  cycleName: string;
  /** Pre-anonymized excerpts only — never author names/emails/Slack IDs. */
  anonymizedComments: string[];
}

export interface UpwardSummaryResult {
  summary: string;
}

/**
 * Provider-agnostic AI review coach. Every implementation MUST:
 *  - respect config.ai.timeoutMs / config.ai.maxRetries
 *  - never throw out of reviewDraft/draftUpwardSummary on provider failure — callers treat a
 *    thrown error as "AI unavailable" and must still be able to save/submit without it
 *  - never be called in a way that blocks Slack ack() (see docs/SECURITY.md)
 *  - never log prompts, answers, or review content
 */
export interface ReviewCoach {
  readonly name: 'none' | 'anthropic' | 'openai';
  reviewDraft(input: ReviewCoachInput): Promise<ReviewCoachResult>;
  draftUpwardSummary(input: UpwardSummaryInput): Promise<UpwardSummaryResult>;
}
