import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { View } from '@slack/types';
import { getEmployeeForSlackUser } from './middleware';
import { getEmployeeById } from '../db/employees';
import { getActiveCycle, getCycleById } from '../db/cycles';
import { saveUpwardFeedback } from '../db/upwardFeedback';
import { logAudit } from '../db/audit';
import { generateAndStoreUpwardFeedback } from '../services/documents';
import { formatFollowupNotes, maybeGenerateFollowupQuestions } from '../services/reviewCoach';

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

function collectUpwardFollowupAnswers(
  state: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>
): string[] {
  return Object.keys(state)
    .filter((key) => key.includes('followup'))
    .sort()
    .map((key) => {
      const actionKey = Object.keys(state[key] ?? {})[0];
      return actionKey ? state[key]?.[actionKey]?.value?.trim() ?? '' : '';
    })
    .filter(Boolean);
}

function buildUpwardFeedbackView(args: {
  managerName: string;
  cycleName: string;
  privateMetadata: string;
  values?: { strengths?: string; improvements?: string; hrNotes?: string; allowHrFollowup?: string };
  followupQuestions?: string[];
}): View {
  const values = args.values ?? {};
  const followupQuestions = args.followupQuestions ?? [];
  return {
    type: 'modal',
    callback_id: 'upward_feedback_submit',
    title: { type: 'plain_text', text: 'Share feedback about your manager' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: args.privateMetadata,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Manager:* ${args.managerName}\n*Cycle:* ${args.cycleName}\n\nRaw submissions are visible to HR. Managers see summarized themes only.`,
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
          initial_value: values.strengths,
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
          initial_value: values.improvements,
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
          initial_value: values.hrNotes,
        },
      },
      {
        type: 'input',
        block_id: blockId('upward', 'followup'),
        label: { type: 'plain_text', text: 'Allow HR follow-up?' },
        element: {
          type: 'radio_buttons',
          action_id: 'allow_hr_followup',
          initial_option: values.allowHrFollowup
            ? {
                text: {
                  type: 'plain_text',
                  text: values.allowHrFollowup === 'yes' ? 'Yes' : 'No',
                },
                value: values.allowHrFollowup,
              }
            : undefined,
          options: [
            { text: { type: 'plain_text', text: 'Yes' }, value: 'yes' },
            { text: { type: 'plain_text', text: 'No' }, value: 'no' },
          ],
        },
      },
      ...(followupQuestions.length
        ? [
            { type: 'divider' as const },
            {
              type: 'section' as const,
              text: {
                type: 'mrkdwn' as const,
                text: 'A quick review coach pass thinks a little more specificity would help. Please answer these follow-up questions before submitting.',
              },
            },
            ...followupQuestions.map((question, index) => ({
              type: 'input' as const,
              block_id: `upward::followup::${index}`,
              label: { type: 'plain_text' as const, text: `Follow-up ${index + 1}` },
              element: {
                type: 'plain_text_input' as const,
                action_id: `followup_${index}`,
                multiline: true,
              },
              hint: { type: 'plain_text' as const, text: question },
            })),
          ]
        : []),
    ],
  };
}

export async function openUpwardFeedbackModal(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
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
    view: buildUpwardFeedbackView({
      managerName: manager.name,
      cycleName: cycle.name,
      privateMetadata: JSON.stringify({
        cycle_id: cycle.id,
        cycle_name: cycle.name,
        employee_id: employee.id,
        manager_id: manager.id,
      }),
    }),
  });
}

export async function handleUpwardFeedbackSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, view, ack } = args;

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const {
    cycle_id: cycleId,
    cycle_name: cycleName,
    employee_id: employeeId,
    manager_id: managerId,
    followup_stage: followupStage,
    followup_questions: followupQuestions,
  } = meta;
  const state = (view.state?.values ?? {}) as Record<
    string,
    Record<string, { value?: string; selected_option?: { value: string } }>
  >;
  const manager = await getEmployeeById(managerId);
  const strengths = getVal(state, 'strengths', 'strengths');
  const improvements = getVal(state, 'improvements', 'improvements');
  const hrNotes = getVal(state, 'hr_notes', 'hr_notes');
  const allowHrFollowup = getVal(state, 'followup', 'allow_hr_followup');

  if (!followupStage) {
    const coach = await maybeGenerateFollowupQuestions({
      flow: 'upward_feedback',
      subjectName: manager?.name ?? 'Manager',
      cycleName: cycleName ?? 'Current cycle',
      answers: [
        { label: 'What does your manager do well?', value: strengths },
        { label: 'What would make them more effective?', value: improvements },
        { label: 'Anything else HR should know?', value: hrNotes },
      ],
    });

    if (coach.needsFollowup) {
      await ack({
        response_action: 'update',
        view: buildUpwardFeedbackView({
          managerName: manager?.name ?? 'Manager',
          cycleName: cycleName ?? 'Current cycle',
          privateMetadata: JSON.stringify({
            cycle_id: cycleId,
            cycle_name: cycleName,
            employee_id: employeeId,
            manager_id: managerId,
            followup_stage: true,
            followup_questions: coach.questions,
          }),
          values: { strengths, improvements, hrNotes, allowHrFollowup },
          followupQuestions: coach.questions,
        }),
      });
      return;
    }
  }

  await ack();

  const feedback = await saveUpwardFeedback(cycleId, employeeId, managerId, {
    strengths,
    improvements,
    hr_notes: hrNotes,
    follow_up_notes: formatFollowupNotes(
      Array.isArray(followupQuestions) ? followupQuestions : [],
      collectUpwardFollowupAnswers(state)
    ),
    allow_hr_followup: allowHrFollowup === 'yes',
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
    await generateAndStoreUpwardFeedback(feedback, cycle.name).catch((error) =>
      console.error('Upward feedback document persistence failed:', error)
    );
  }
}
