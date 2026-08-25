import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { View } from '@slack/types';
import { getActorForSlackUser } from './middleware';
import { getActiveCycle } from '../db/cycles';
import { getSelfReflection, saveSelfReflectionDraft, submitSelfReflection } from '../db/selfReflections';
import { logAudit } from '../db/audit';
import { claimSlackDelivery } from './idempotency';
import { requireCyclePhase } from '../domain/cycleStateMachine';
import { refreshHomeForUser } from './home';
import { escapeMrkdwn } from '../domain/slackFormat';
import type { SelfReflectionPromptConfig } from '../types';

const SUBMIT_MODE_BLOCK = 'self_reflection::submit_mode';

function promptBlockId(key: string): string {
  return `self_reflection::prompt::${key}`;
}

function buildSelfReflectionView(args: {
  prompts: SelfReflectionPromptConfig[];
  answers: Record<string, string>;
  privateMetadata: string;
  cycleName: string;
  alreadySubmitted: boolean;
}): View {
  return {
    type: 'modal',
    callback_id: 'self_reflection_submit',
    title: { type: 'plain_text', text: 'Self reflection' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Close' },
    private_metadata: args.privateMetadata,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*Cycle:* ${escapeMrkdwn(args.cycleName)}` } },
      ...args.prompts.map((prompt) => ({
        type: 'input' as const,
        block_id: promptBlockId(prompt.key),
        optional: !prompt.required,
        label: { type: 'plain_text' as const, text: prompt.label.slice(0, 150) },
        element: {
          type: 'plain_text_input' as const,
          action_id: 'value',
          multiline: true,
          initial_value: args.answers[prompt.key] ?? '',
        },
      })),
      {
        type: 'input',
        block_id: SUBMIT_MODE_BLOCK,
        label: { type: 'plain_text', text: 'When you click Save' },
        element: {
          type: 'radio_buttons',
          action_id: 'mode',
          initial_option: { text: { type: 'plain_text', text: 'Save as draft (come back later)' }, value: 'draft' },
          options: [
            { text: { type: 'plain_text', text: 'Save as draft (come back later)' }, value: 'draft' },
            { text: { type: 'plain_text', text: 'Submit as final (cannot edit afterward)' }, value: 'submit' },
          ],
        },
      },
    ],
  };
}

export async function openSelfReflectionModal(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();
  const triggerId = 'trigger_id' in body ? body.trigger_id : undefined;
  if (!triggerId) return;

  const actor = await getActorForSlackUser(body.user?.id);
  const cycle = await getActiveCycle();
  if (!actor || !cycle) {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Self reflection' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: !actor ? "You're not in the employee directory." : 'No active review cycle.',
            },
          },
        ],
      },
    });
    return;
  }

  const existing = await getSelfReflection(cycle.id, actor.employee.id);
  if (existing?.state === 'submitted') {
    await client.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Self reflection' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Your self-reflection has already been submitted for this cycle.' },
          },
        ],
      },
    });
    return;
  }

  await client.views.open({
    trigger_id: triggerId,
    view: buildSelfReflectionView({
      prompts: cycle.self_reflection_prompts,
      answers: existing?.answers ?? {},
      privateMetadata: JSON.stringify({ cycle_id: cycle.id, employee_id: actor.employee.id, prompt_version: 1 }),
      cycleName: cycle.name,
      alreadySubmitted: false,
    }),
  });
}

export async function handleSelfReflectionSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const { view, ack, body } = args;
  const meta = JSON.parse(view.private_metadata || '{}') as {
    cycle_id: string;
    employee_id: string;
    prompt_version: number;
  };
  const actor = await getActorForSlackUser(body.user?.id);

  if (!actor || actor.employee.id !== meta.employee_id) {
    await ack();
    return;
  }

  const state = view.state?.values ?? {};
  const answers: Record<string, string> = {};
  for (const [blockId, blockValues] of Object.entries(state)) {
    if (!blockId.startsWith('self_reflection::prompt::')) continue;
    const key = blockId.replace('self_reflection::prompt::', '');
    answers[key] = (blockValues.value as { value?: string })?.value?.trim() ?? '';
  }
  const mode =
    (state[SUBMIT_MODE_BLOCK]?.mode as { selected_option?: { value?: string } })?.selected_option?.value ?? 'draft';

  const cycle = await getActiveCycle();
  if (!cycle || cycle.id !== meta.cycle_id) {
    await ack();
    return;
  }

  try {
    requireCyclePhase(cycle.status, 'self_reflection_edit');
  } catch {
    await ack();
    return;
  }

  // Deterministic, immediate validation of required prompts before any write — Slack modal
  // field errors must be returned synchronously from ack(), not discovered after the fact.
  if (mode === 'submit') {
    const errors: Record<string, string> = {};
    for (const prompt of cycle.self_reflection_prompts) {
      if (prompt.required && !(answers[prompt.key] ?? '').trim()) {
        errors[promptBlockId(prompt.key)] = 'This field is required to submit.';
      }
    }
    if (Object.keys(errors).length > 0) {
      await ack({ response_action: 'errors', errors });
      return;
    }
  }

  // Idempotency is claimed only after validation passes, so a resubmission after fixing a
  // validation error is never mistaken for a duplicate delivery of the same valid submission.
  const isFirst = await claimSlackDelivery('self_reflection_submit', body);
  if (!isFirst) {
    await ack();
    return;
  }

  await ack();

  await saveSelfReflectionDraft(meta.cycle_id, actor.employee.id, meta.prompt_version, answers);
  if (mode === 'submit') {
    await submitSelfReflection(meta.cycle_id, actor.employee.id);
    await logAudit({
      entity_type: 'self_reflection',
      entity_id: actor.employee.id,
      action: 'submit',
      actor_id: actor.employee.id,
      actor_slack_id: body.user?.id,
      cycle_id: meta.cycle_id,
    });
  } else {
    await logAudit({
      entity_type: 'self_reflection',
      entity_id: actor.employee.id,
      action: 'save_draft',
      actor_id: actor.employee.id,
      actor_slack_id: body.user?.id,
      cycle_id: meta.cycle_id,
    });
  }

  if (body.user?.id) await refreshHomeForUser(args.client, body.user.id);
}
