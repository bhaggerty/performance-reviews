import type {
  ReviewCoach,
  ReviewCoachInput,
  ReviewCoachResult,
  UpwardSummaryInput,
  UpwardSummaryResult,
} from './types';

/** Default provider. AI is entirely disabled: every call returns "no opinion" instantly. */
export class NoopReviewCoach implements ReviewCoach {
  readonly name = 'none' as const;

  reviewDraft(_input: ReviewCoachInput): Promise<ReviewCoachResult> {
    return Promise.resolve({ needsFollowup: false, questions: [] });
  }

  draftUpwardSummary(_input: UpwardSummaryInput): Promise<UpwardSummaryResult> {
    return Promise.resolve({ summary: '' });
  }
}
