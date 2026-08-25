import { config } from '../../config';
import { NoopReviewCoach } from './noop';
import { AnthropicReviewCoach } from './anthropic';
import { OpenAIReviewCoach } from './openai';
import type { ReviewCoach } from './types';

export type {
  ReviewCoach,
  ReviewCoachInput,
  ReviewCoachResult,
  UpwardSummaryInput,
  UpwardSummaryResult,
} from './types';
export { NoopReviewCoach } from './noop';
export { AnthropicReviewCoach } from './anthropic';
export { OpenAIReviewCoach } from './openai';

function buildReviewCoach(): ReviewCoach {
  switch (config.ai.provider) {
    case 'anthropic':
      return new AnthropicReviewCoach(config.ai.anthropic.apiKey, config.ai.anthropic.model);
    case 'openai':
      return new OpenAIReviewCoach(config.ai.openai.apiKey, config.ai.openai.model);
    case 'none':
    default:
      return new NoopReviewCoach();
  }
}

/** Singleton, selected once at startup from AI_PROVIDER. Core workflows never depend on this
 * being anything other than NoopReviewCoach — it is purely an optional enhancement. */
export const reviewCoach: ReviewCoach = buildReviewCoach();
