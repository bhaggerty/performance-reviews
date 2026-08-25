import { describe, it, expect, vi } from 'vitest';
import { NoopReviewCoach } from '../../src/services/reviewCoach/noop';
import { substantiveAnswers, shouldConsiderFollowup } from '../../src/services/reviewCoach/shared';
import type { ReviewCoachInput } from '../../src/services/reviewCoach/types';

describe('NoopReviewCoach', () => {
  it('reviewDraft always returns no follow-up', async () => {
    const coach = new NoopReviewCoach();
    const result = await coach.reviewDraft({ flow: 'manager_review', subjectName: 'X', cycleName: 'Y', answers: [] });
    expect(result).toEqual({ needsFollowup: false, questions: [] });
  });

  it('draftUpwardSummary always returns an empty summary', async () => {
    const coach = new NoopReviewCoach();
    const result = await coach.draftUpwardSummary({ managerName: 'M', cycleName: 'Y', anonymizedComments: [] });
    expect(result).toEqual({ summary: '' });
  });
});

function input(answers: Array<{ label: string; value?: string }>): ReviewCoachInput {
  return { flow: 'manager_review', subjectName: 'Someone', cycleName: 'Cycle', answers };
}

describe('substantiveAnswers / shouldConsiderFollowup', () => {
  it('filters out answers shorter than 20 characters', () => {
    const result = substantiveAnswers(
      input([
        { label: 'a', value: 'short' },
        { label: 'b', value: 'this one is definitely long enough' },
      ])
    );
    expect(result).toEqual(['this one is definitely long enough']);
  });

  it('treats blank/undefined values as non-substantive', () => {
    const result = substantiveAnswers(
      input([
        { label: 'a', value: undefined },
        { label: 'b', value: '   ' },
      ])
    );
    expect(result).toEqual([]);
  });

  it('recommends follow-up when fewer than 2 substantive answers exist', () => {
    expect(
      shouldConsiderFollowup(input([{ label: 'a', value: 'one substantive answer right here, long enough' }]))
    ).toBe(true);
  });

  it('recommends follow-up when total substantive characters are under 220', () => {
    const shortAnswer = 'x'.repeat(25);
    expect(
      shouldConsiderFollowup(
        input([
          { label: 'a', value: shortAnswer },
          { label: 'b', value: shortAnswer },
        ])
      )
    ).toBe(true);
  });

  it('does not recommend follow-up for a sufficiently detailed draft', () => {
    const longAnswer = 'This is a detailed, specific answer with concrete examples and enough length. '.repeat(3);
    expect(
      shouldConsiderFollowup(
        input([
          { label: 'a', value: longAnswer },
          { label: 'b', value: longAnswer },
        ])
      )
    ).toBe(false);
  });
});

describe('AnthropicReviewCoach — never makes a real network call, fails safe', () => {
  it('reviewDraft resolves to no-follow-up when the SDK call rejects (simulated timeout/error)', async () => {
    const createMock = vi.fn().mockRejectedValue(new Error('simulated network failure'));
    class FakeAnthropic {
      messages = { create: createMock };
    }
    vi.resetModules();
    vi.doMock('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }));
    const { AnthropicReviewCoach } = await import('../../src/services/reviewCoach/anthropic');
    const coach = new AnthropicReviewCoach('fake-key', 'claude-test');

    const result = await coach.reviewDraft(input([{ label: 'a', value: 'short' }]));

    expect(result).toEqual({ needsFollowup: false, questions: [] });
    expect(createMock).toHaveBeenCalled(); // proves the mock intercepted the call, not a real API
    vi.doUnmock('@anthropic-ai/sdk');
  });

  it('draftUpwardSummary resolves to an empty summary when the SDK call rejects', async () => {
    const createMock = vi.fn().mockRejectedValue(new Error('simulated network failure'));
    class FakeAnthropic {
      messages = { create: createMock };
    }
    vi.resetModules();
    vi.doMock('@anthropic-ai/sdk', () => ({ default: FakeAnthropic }));
    const { AnthropicReviewCoach } = await import('../../src/services/reviewCoach/anthropic');
    const coach = new AnthropicReviewCoach('fake-key', 'claude-test');

    const result = await coach.draftUpwardSummary({
      managerName: 'M',
      cycleName: 'C',
      anonymizedComments: ['a comment'],
    });

    expect(result).toEqual({ summary: '' });
    expect(createMock).toHaveBeenCalled();
    vi.doUnmock('@anthropic-ai/sdk');
  });
});

describe('OpenAIReviewCoach — never makes a real network call, fails safe', () => {
  it('reviewDraft resolves to no-follow-up when the SDK call rejects (simulated timeout/error)', async () => {
    const createMock = vi.fn().mockRejectedValue(new Error('simulated network failure'));
    class FakeOpenAI {
      chat = { completions: { create: createMock } };
    }
    vi.resetModules();
    vi.doMock('openai', () => ({ default: FakeOpenAI }));
    const { OpenAIReviewCoach } = await import('../../src/services/reviewCoach/openai');
    const coach = new OpenAIReviewCoach('fake-key', 'gpt-test');

    const result = await coach.reviewDraft(input([{ label: 'a', value: 'short' }]));

    expect(result).toEqual({ needsFollowup: false, questions: [] });
    expect(createMock).toHaveBeenCalled();
    vi.doUnmock('openai');
  });

  it('reviewDraft skips the API call entirely when the draft is already substantive', async () => {
    const createMock = vi.fn();
    class FakeOpenAI {
      chat = { completions: { create: createMock } };
    }
    vi.resetModules();
    vi.doMock('openai', () => ({ default: FakeOpenAI }));
    const { OpenAIReviewCoach } = await import('../../src/services/reviewCoach/openai');
    const coach = new OpenAIReviewCoach('fake-key', 'gpt-test');

    const longAnswer = 'This is a detailed, specific answer with concrete examples and enough length. '.repeat(3);
    const result = await coach.reviewDraft(
      input([
        { label: 'a', value: longAnswer },
        { label: 'b', value: longAnswer },
      ])
    );

    expect(result).toEqual({ needsFollowup: false, questions: [] });
    expect(createMock).not.toHaveBeenCalled();
    vi.doUnmock('openai');
  });
});
