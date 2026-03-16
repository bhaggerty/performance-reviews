import type { SlackActionMiddlewareArgs, SlackViewMiddlewareArgs, BlockAction, ViewSubmitAction, AllMiddlewareArgs } from '@slack/bolt';
import { getEmployeeForSlackUser } from './middleware';
import { getEmployeeById } from '../db/employees';
import { getActiveCycle, getCycleById } from '../db/cycles';
import { saveUpwardFeedback } from '../db/upwardFeedback';
import { logAudit } from '../db/audit';
import { generateAndStoreUpwardFeedback } from '../services/documents';

function blockId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts].join('::');
}

function getVal(
  state: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>,
  blockKey: string,
  actionKey: string
): string | undefined {
  for (const k of Object.keys(state)) {
    if (!k.includes(blockKey)) continue;
    const v = state[k]?.[actionKey];
    if (v?.value) return v.value;
    if (v?.selected_option?.value) return v.selected_option.value;
  }
  return undefined;
}

export async function openUpwardFeedbackModal(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();

  const slackUserId = body.user?.id ?? '';
  const employee = await getEmployeeForSlackUser(slackUserId);
  const cycle = await getActiveCycle();

  if (!employee || !cycle) {
    await client.views.open({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Upward feedback' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: !employee ? "You're not in the employee directory." : 'No active review cycle.',
            },
          },
        ],
      },
    });
    return;
  }

  const manager = employee.manager_id ? await getEmployeeById(employee.manager_id) : null;
  if (!manager) {
    await client.views.open({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Upward feedback' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'You have no manager set in the directory.',
            },
          },
        ],
      },
    });
    return;
  }

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      callback_id: 'upward_feedback_submit',
      title: { type: 'plain_text', text: 'Share feedback about your manager' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({
        cycle_id: cycle.id,
        employee_id: employee.id,
        manager_id: manager.id,
      }),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Manager:* ${manager.name}\n*Cycle:* ${cycle.name}\n\nRaw submissions are visible to HR. Managers see summarized themes only.`,
          },
        },
        {
          type: 'input',
          block_id: blockId('upward', 'strengths'),
          label: { type: 'plain_text', text: 'What does your manager do well?' },
          element: {
            type: 'plain_text_input',
            action_id: 'strengths',
            multiline: true,
          },
        },
        {
          type: 'input',
          block_id: blockId('upward', 'improvements'),
          label: { type: 'plain_text', text: 'What would make them more effective?' },
          element: {
            type: 'plain_text_input',
            action_id: 'improvements',
            multiline: true,
          },
        },
        {
          type: 'input',
          block_id: blockId('upward', 'hr_notes'),
          label: { type: 'plain_text', text: 'Anything else HR should know?' },
          optional: true,
          element: {
            type: 'plain_text_input',
            action_id: 'hr_notes',
            multiline: true,
          },
        },
        {
          type: 'input',
          block_id: blockId('upward', 'followup'),
          label: { type: 'plain_text', text: 'Allow HR follow-up?' },
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
    },
  });
}

export async function handleUpwardFeedbackSubmit(args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs): Promise<void> {
  const { body, view, ack } = args;
  await ack();

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { cycle_id: cycleId, employee_id: employeeId, manager_id: managerId } = meta;
  const state = (view.state?.values ?? {}) as Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>;
  const allow_hr_followup = getVal(state, 'followup', 'allow_hr_followup') === 'yes';

  const feedback = await saveUpwardFeedback(cycleId, employeeId, managerId, {
    strengths: getVal(state, 'strengths', 'strengths'),
    improvements: getVal(state, 'improvements', 'improvements'),
    hr_notes: getVal(state, 'hr_notes', 'hr_notes'),
    allow_hr_followup,
  });

  await logAudit({
    entity_type: 'upward_feedback',
    entity_id: employeeId,
    action: 'submit',
    actor_id: employeeId,
    actor_slack_id: body.user?.id,
    details: { cycle_id: cycleId, manager_id: managerId },
  });

  const cycle = await getCycleById(cycleId);
  if (cycle) {
    await generateAndStoreUpwardFeedback(feedback, cycle.name).catch((err) =>
      console.error('Upward feedback document persistence failed:', err)
    );
  }
}
