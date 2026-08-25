import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config';
import { logger } from '../../logger';
import type {
  ReviewCoach,
  ReviewCoachInput,
  ReviewCoachResult,
  UpwardSummaryInput,
  UpwardSummaryResult,
} from './types';
import {
  REVIEW_DRAFT_SYSTEM_PROMPT,
  reviewDraftPrompt,
  reviewDraftResponseSchema,
  shouldConsiderFollowup,
  upwardSummaryPrompt,
  withTimeoutAndRetries,
} from './shared';

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export class AnthropicReviewCoach implements ReviewCoach {
  readonly name = 'anthropic' as const;
  private client: Anthropic;

  constructor(
    apiKey: string,
    private model: string
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async reviewDraft(input: ReviewCoachInput): Promise<ReviewCoachResult> {
    if (!shouldConsiderFollowup(input)) return { needsFollowup: false, questions: [] };
    try {
      const text = await withTimeoutAndRetries(
        (signal) =>
          this.client.messages
            .create(
              {
                model: this.model,
                max_tokens: 300,
                system: REVIEW_DRAFT_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: reviewDraftPrompt(input) }],
              },
              { signal }
            )
            .then(extractText),
        { timeoutMs: config.ai.timeoutMs, maxRetries: config.ai.maxRetries }
      );
      const parsed = reviewDraftResponseSchema.parse(JSON.parse(text));
      return { needsFollowup: parsed.needs_followup && parsed.questions.length > 0, questions: parsed.questions };
    } catch (error) {
      logger.warn('AI review coach (anthropic) unavailable; continuing without follow-up.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { needsFollowup: false, questions: [] };
    }
  }

  async draftUpwardSummary(input: UpwardSummaryInput): Promise<UpwardSummaryResult> {
    try {
      const text = await withTimeoutAndRetries(
        (signal) =>
          this.client.messages
            .create(
              {
                model: this.model,
                max_tokens: 500,
                messages: [
                  {
                    role: 'user',
                    content: upwardSummaryPrompt(input.managerName, input.cycleName, input.anonymizedComments),
                  },
                ],
              },
              { signal }
            )
            .then(extractText),
        { timeoutMs: config.ai.timeoutMs, maxRetries: config.ai.maxRetries }
      );
      return { summary: text };
    } catch (error) {
      logger.warn('AI upward-summary draft (anthropic) unavailable.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { summary: '' };
    }
  }
}
