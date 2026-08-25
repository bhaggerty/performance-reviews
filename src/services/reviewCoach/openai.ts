import OpenAI from 'openai';
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

export class OpenAIReviewCoach implements ReviewCoach {
  readonly name = 'openai' as const;
  private client: OpenAI;

  constructor(
    apiKey: string,
    private model: string
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async reviewDraft(input: ReviewCoachInput): Promise<ReviewCoachResult> {
    if (!shouldConsiderFollowup(input)) return { needsFollowup: false, questions: [] };
    try {
      const text = await withTimeoutAndRetries(
        async (signal) => {
          const response = await this.client.chat.completions.create(
            {
              model: this.model,
              max_tokens: 300,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: REVIEW_DRAFT_SYSTEM_PROMPT },
                { role: 'user', content: reviewDraftPrompt(input) },
              ],
            },
            { signal }
          );
          return response.choices[0]?.message?.content ?? '{}';
        },
        { timeoutMs: config.ai.timeoutMs, maxRetries: config.ai.maxRetries }
      );
      const parsed = reviewDraftResponseSchema.parse(JSON.parse(text));
      return { needsFollowup: parsed.needs_followup && parsed.questions.length > 0, questions: parsed.questions };
    } catch (error) {
      logger.warn('AI review coach (openai) unavailable; continuing without follow-up.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { needsFollowup: false, questions: [] };
    }
  }

  async draftUpwardSummary(input: UpwardSummaryInput): Promise<UpwardSummaryResult> {
    try {
      const text = await withTimeoutAndRetries(
        async (signal) => {
          const response = await this.client.chat.completions.create(
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
          );
          return response.choices[0]?.message?.content ?? '';
        },
        { timeoutMs: config.ai.timeoutMs, maxRetries: config.ai.maxRetries }
      );
      return { summary: text };
    } catch (error) {
      logger.warn('AI upward-summary draft (openai) unavailable.', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { summary: '' };
    }
  }
}
