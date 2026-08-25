import { z } from 'zod';
import type { ReviewCoachInput } from './types';

export function substantiveAnswers(input: ReviewCoachInput): string[] {
  return input.answers.map((answer) => (answer.value ?? '').trim()).filter((value) => value.length >= 20);
}

export function shouldConsiderFollowup(input: ReviewCoachInput): boolean {
  const answers = substantiveAnswers(input);
  const totalChars = answers.reduce((sum, answer) => sum + answer.length, 0);
  return answers.length < 2 || totalChars < 220;
}

export function reviewDraftPrompt(input: ReviewCoachInput): string {
  const lines = input.answers.map((answer) => `${answer.label}: ${answer.value?.trim() || '(blank)'}`);
  return [
    `Flow: ${input.flow}`,
    `Subject: ${input.subjectName}`,
    `Cycle: ${input.cycleName}`,
    input.status ? `Status: ${input.status}` : undefined,
    '',
    'Current draft:',
    ...lines,
    '',
    'Rules:',
    '- Ask at most 2 follow-up questions.',
    '- Only ask if the draft lacks enough specifics to support a fair review or useful document.',
    '- Questions should be concrete and aimed at examples, impact, scope, or the root issue.',
    '- If the draft is already specific enough, needs_followup must be false and questions must be empty.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const REVIEW_DRAFT_SYSTEM_PROMPT =
  'You help performance review submitters add missing specifics. Respond with strict JSON only, no markdown, matching {"needs_followup": boolean, "questions": string[]}.';

export const reviewDraftResponseSchema = z.object({
  needs_followup: z.boolean().default(false),
  questions: z.array(z.string()).max(2).default([]),
});

export function upwardSummaryPrompt(managerName: string, cycleName: string, comments: string[]): string {
  return [
    `Manager: ${managerName}`,
    `Cycle: ${cycleName}`,
    '',
    'Anonymized upward feedback comments (author identities already removed):',
    ...comments.map((c, i) => `${i + 1}. ${c}`),
    '',
    'Write a brief, balanced, factual summary of common themes for a People administrator to',
    'review and edit before it is ever shown to the manager. Do not invent details not present',
    'in the comments. Do not name or imply the identity of any individual respondent.',
  ].join('\n');
}

export async function withTimeoutAndRetries<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs: number; maxRetries: number }
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await fn(controller.signal);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
