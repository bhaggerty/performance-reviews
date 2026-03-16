import { config } from '../config';

type ReviewCoachInput = {
  flow: 'manager_review' | 'peer_feedback' | 'upward_feedback';
  subjectName: string;
  cycleName: string;
  status?: string;
  answers: Array<{ label: string; value?: string }>;
};

export type ReviewCoachResult = {
  needsFollowup: boolean;
  questions: string[];
};

function configured(): boolean {
  return Boolean(config.ai.apiKey);
}

function substantiveAnswers(input: ReviewCoachInput): string[] {
  return input.answers
    .map((answer) => (answer.value ?? '').trim())
    .filter((value) => value.length >= 20);
}

function shouldConsiderFollowup(input: ReviewCoachInput): boolean {
  const answers = substantiveAnswers(input);
  const totalChars = answers.reduce((sum, answer) => sum + answer.length, 0);
  return answers.length < 2 || totalChars < 220;
}

function promptForInput(input: ReviewCoachInput): string {
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
    'Return compact JSON only in this shape:',
    '{"needs_followup":true,"questions":["question 1","question 2"]}',
    '',
    'Rules:',
    '- Ask at most 2 follow-up questions.',
    '- Only ask if the draft lacks enough specifics to support a fair review or useful document.',
    '- Questions should be concrete and aimed at examples, impact, scope, or the root issue.',
    '- If the draft is already specific enough, return {"needs_followup":false,"questions":[]}.',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractOutputText(data: any): string {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const texts: string[] = [];
  for (const output of data?.output ?? []) {
    for (const content of output?.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        texts.push(content.text);
      }
    }
  }
  return texts.join('\n').trim();
}

export async function maybeGenerateFollowupQuestions(
  input: ReviewCoachInput
): Promise<ReviewCoachResult> {
  if (!configured() || !shouldConsiderFollowup(input)) {
    return { needsFollowup: false, questions: [] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_output_tokens: 220,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  'You help performance review submitters add missing specifics. Respond with JSON only and no markdown.',
              },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: promptForInput(input) }],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed with status ${response.status}`);
    }

    const data = await response.json();
    const outputText = extractOutputText(data);
    const parsed = JSON.parse(outputText) as {
      needs_followup?: boolean;
      questions?: unknown;
    };

    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .filter((question): question is string => typeof question === 'string')
          .map((question) => question.trim())
          .filter(Boolean)
          .slice(0, 2)
      : [];

    return {
      needsFollowup: Boolean(parsed.needs_followup) && questions.length > 0,
      questions,
    };
  } catch (error) {
    console.error('Review coach skipped:', error);
    return { needsFollowup: false, questions: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export function formatFollowupNotes(
  questions: string[],
  answers: string[]
): string | undefined {
  const pairs = questions
    .map((question, index) => ({ question, answer: answers[index]?.trim() || '' }))
    .filter((pair) => pair.answer);

  if (pairs.length === 0) return undefined;

  return [
    'AI follow-up clarification',
    ...pairs.map((pair) => `Q: ${pair.question}\nA: ${pair.answer}`),
  ].join('\n\n');
}
