import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { View } from '@slack/types';
import { getActorForSlackUser } from './middleware';
import { getEmployeeById } from '../db/employees';
import { getActiveCycle, getCycleById } from '../db/cycles';
import { getUpwardFeedbackForEmployee, saveUpwardFeedback } from '../db/upwardFeedback';
import { logAudit } from '../db/audit';
import { generateAndStoreUpwardFeedback } from '../services/documents';
import { requireCyclePhase } from '../domain/cycleStateMachine';
import { claimSlackDelivery } from './idempotency';
import { escapeMrkdwn } from '../domain/slackFormat';

function blockId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts].join('::');
}

function getVal(
  state: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>,
  blockKey: string,
  actionKey: string
): string | undefined {
  for (const key of Object.keys(state)) {
    if (!key.includes(blockKey)) continue;
    const value = state[key]?.[actionKey];
    if (value?.value) return value.value;
    if (value?.selected_option?.value) return value.selected_option.value;
  }
  return undefined;
}

function buildUpwardFeedbackView(args: { managerName: string; cycleName: string; privateMetadata: string }): View {
  return {
    type: 'modal',
    callback_id: 'upward_feedback_submit',
    title: { type: 'plain_text', text: 'Feedback about your manager' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: args.privateMetadata,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Manager:* ${escapeMrkdwn(args.managerName)}\n*Cycle:* ${escapeMrkdwn(args.cycleName)}\n\nThis is a one-time, final submission. Raw responses are visible only to authorized People administrators — your manager never sees who wrote what.`,
        },
      },
      {
        type: 'input',
        block_id: blockId('upward', 'strengths'),
        label: { type: 'plain_text', text: 'What does your manager do well?' },
        element: { type: 'plain_text_input', action_id: 'strengths', multiline: true },
      },
      {
        type: 'input',
        block_id: blockId('upward', 'improvements'),
        label: { type: 'plain_text', text: 'What would make them more effective?' },
        element: { type: 'plain_text_input', action_id: 'improvements', multiline: true },
      },
      {
        type: 'input',
        block_id: blockId('upward', 'hr_notes'),
        label: { type: 'plain_text', text: 'Anything else People Ops should know?' },
        optional: true,
        element: { type: 'plain_text_input', action_id: 'hr_notes', multiline: true },
      },
      {
        type: 'input',
        block_id: blockId('upward', 'followup'),
        label: { type: 'plain_text', text: 'May People Ops follow up with you privately?' },
        element: {
          type: 'radio_buttons',
          action_id: 'allow_hr_followup',
          options: [
            { text: { type: 'plain_text', text: 'Yes' }, value: 'yes' },
            { text: { type: 'plain_text', text: 'No' }, value: 'no' },
          ],
        },
      },
    ],
  };
}

export async function openUpwardFeedbackModal(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();
  const triggerId = body.trigger_id;
  const actor = await getActorForSlackUser(body.user?.id);
  const cycle = await getActiveCycle();

  if (!actor || !cycle) {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal('Upward feedback', !actor ? "You're not in the employee directory." : 'No active review cycle.'),
    });
    return;
  }
  try {
    requireCyclePhase(cycle.status, 'upward_feedback_submit');
  } catch {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal('Upward feedback', `Upward feedback is not open right now (cycle phase: ${cycle.status}).`),
    });
    return;
  }

  // Manager is re-resolved fresh from the live employee record every time — never trusted from a stale modal.
  const manager = actor.employee.manager_id ? await getEmployeeById(actor.employee.manager_id) : null;
  if (!manager) {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal('Upward feedback', 'You have no manager set in the directory.'),
    });
    return;
  }

  const existing = await getUpwardFeedbackForEmployee(cycle.id, actor.employee.id);
  if (existing) {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal('Already submitted', 'You already submitted upward feedback for this cycle.'),
    });
    return;
  }

  await client.views.open({
    trigger_id: triggerId,
    view: buildUpwardFeedbackView({
      managerName: manager.name,
      cycleName: cycle.name,
      privateMetadata: JSON.stringify({ cycle_id: cycle.id, cycle_name: cycle.name, employee_id: actor.employee.id }),
    }),
  });
}

export async function handleUpwardFeedbackSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, view, ack } = args;
  await ack();

  const isFirst = await claimSlackDelivery('upward_feedback_submit', body);
  if (!isFirst) return;

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { cycle_id: cycleId, cycle_name: cycleName, employee_id: employeeId } = meta;

  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor || actor.employee.id !== employeeId) return;

  // Manager is re-resolved fresh at submit time, not trusted from the modal's private_metadata.
  const manager = actor.employee.manager_id ? await getEmployeeById(actor.employee.manager_id) : null;
  if (!manager) return;

  const cycle = await getCycleById(cycleId);
  try {
    if (cycle) requireCyclePhase(cycle.status, 'upward_feedback_submit');
  } catch {
    return;
  }

  const state = (view.state?.values ?? {}) as Record<
    string,
    Record<string, { value?: string; selected_option?: { value: string } }>
  >;
  const strengths = getVal(state, 'strengths', 'strengths');
  const improvements = getVal(state, 'improvements', 'improvements');
  const hrNotes = getVal(state, 'hr_notes', 'hr_notes');
  const allowHrFollowup = getVal(state, 'followup', 'allow_hr_followup');

  try {
    const feedback = await saveUpwardFeedback(cycleId, employeeId, manager.id, {
      strengths,
      improvements,
      hr_notes: hrNotes,
      allow_hr_followup: allowHrFollowup === 'yes',
    });

    await logAudit({
      entity_type: 'upward_feedback',
      entity_id: employeeId,
      action: 'submit',
      actor_id: employeeId,
      actor_slack_id: body.user?.id,
      cycle_id: cycleId,
      manager_id: manager.id,
    });

    if (cycleName) {
      await generateAndStoreUpwardFeedback(feedback, cycleName).catch(() => undefined);
    }
    // Deliberately no notification to the manager — upward feedback release is a separate,
    // Primary-Approver-gated action (see src/api/console/upwardFeedback.ts).
  } catch {
    // Duplicate final submission — saveUpwardFeedback's conditional write already rejected it.
  }
}

function infoModal(title: string, text: string): View {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: title.slice(0, 24) },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}
