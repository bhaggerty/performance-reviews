import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { KnownBlock, View } from '@slack/types';
import { getEmployeeForSlackUser } from './middleware';
import { getDirectReports, getEmployeeById } from '../db/employees';
import { getActiveCycle, getCycleById } from '../db/cycles';
import { getManagerReview, saveManagerReview } from '../db/reviews';
import { logAudit } from '../db/audit';
import { generateAndStoreManagerReview } from '../services/documents';
import { formatFollowupNotes, maybeGenerateFollowupQuestions } from '../services/reviewCoach';
import type { ReviewStatus } from '../types';

const MAX_EMPLOYEES_IN_DROPDOWN = 100;

type ReviewFormState = Record<
  string,
  Record<string, { value?: string; selected_option?: { value: string } }>
>;

type ManagerDraftValues = {
  strengths?: string;
  focusAreas?: string;
  examples?: string;
  developmentAreas?: string;
  nextCycleExpectations?: string;
  managerSupport?: string;
  primaryConcerns?: string;
  communicated?: string;
  requiredImprovement?: string;
  improvementTimeline?: string;
  hrReview?: string;
  followupAnswers?: string[];
};

function blockId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts].join('::');
}

function getValFromState(
  state: ReviewFormState,
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

function collectManagerDraftValues(state: ReviewFormState): ManagerDraftValues {
  const getVal = (blockKey: string, actionKey: string) => getValFromState(state, blockKey, actionKey);
  const followupAnswers = Object.keys(state)
    .filter((key) => key.includes('followup'))
    .sort()
    .map((key) => {
      const actionKey = Object.keys(state[key] ?? {})[0];
      return actionKey ? state[key]?.[actionKey]?.value?.trim() ?? '' : '';
    })
    .filter(Boolean);

  return {
    strengths: getVal('strengths', 'strengths'),
    focusAreas: getVal('focus_areas', 'focus_areas'),
    examples: getVal('examples', 'examples'),
    developmentAreas: getVal('development_areas', 'development_areas'),
    nextCycleExpectations: getVal('next_cycle_expectations', 'next_cycle_expectations'),
    managerSupport: getVal('manager_support', 'manager_support'),
    primaryConcerns: getVal('primary_concerns', 'primary_concerns'),
    communicated: getVal('communicated', 'communicated'),
    requiredImprovement: getVal('required_improvement', 'required_improvement'),
    improvementTimeline: getVal('improvement_timeline', 'improvement_timeline'),
    hrReview: getVal('hr_review', 'hr_review'),
    followupAnswers,
  };
}

function buildFollowupBlocks(questions: string[]): KnownBlock[] {
  if (questions.length === 0) return [];
  return [
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'A quick review coach pass thinks a little more specificity would help. Please answer these follow-up questions before submitting.',
      },
    },
    ...questions.map((question, index) => ({
      type: 'input' as const,
      block_id: blockId('review', 'followup', String(index)),
      label: { type: 'plain_text' as const, text: `Follow-up ${index + 1}` },
      element: {
        type: 'plain_text_input' as const,
        action_id: `followup_${index}`,
        multiline: true,
      },
      hint: { type: 'plain_text' as const, text: question },
    })),
  ];
}

function buildManagerReviewView(args: {
  status: ReviewStatus;
  employeeName: string;
  cycleName: string;
  privateMeta: string;
  values?: ManagerDraftValues;
  followupQuestions?: string[];
}): View {
  const values = args.values ?? {};
  const header: KnownBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Employee:* ${args.employeeName}\n*Cycle:* ${args.cycleName}`,
    },
  };

  const followupBlocks = buildFollowupBlocks(args.followupQuestions ?? []);

  if (args.status === 'on_track') {
    return {
      type: 'modal',
      callback_id: 'manager_review_submit',
      title: { type: 'plain_text', text: 'Doing Great - Quick feedback' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Back' },
      private_metadata: args.privateMeta,
      blocks: [
        header,
        {
          type: 'input',
          block_id: blockId('review', 'strengths'),
          label: { type: 'plain_text', text: 'What is going well?' },
          element: {
            type: 'plain_text_input',
            action_id: 'strengths',
            multiline: true,
            initial_value: values.strengths,
            placeholder: {
              type: 'plain_text',
              text: 'e.g. Strong execution, great collaboration',
            },
          },
        },
        {
          type: 'input',
          block_id: blockId('review', 'focus_areas'),
          label: { type: 'plain_text', text: 'What should they keep focusing on next cycle?' },
          element: {
            type: 'plain_text_input',
            action_id: 'focus_areas',
            multiline: true,
            initial_value: values.focusAreas,
            placeholder: {
              type: 'plain_text',
              text: 'e.g. Continue scaling automation',
            },
          },
        },
        {
          type: 'input',
          block_id: blockId('review', 'examples'),
          label: { type: 'plain_text', text: 'Examples of impact (optional)' },
          optional: true,
          element: {
            type: 'plain_text_input',
            action_id: 'examples',
            multiline: true,
            initial_value: values.examples,
          },
        },
        ...followupBlocks,
      ],
    };
  }

  if (args.status === 'needs_focus') {
    return {
      type: 'modal',
      callback_id: 'manager_review_submit',
      title: { type: 'plain_text', text: 'Needs Focus - Development areas' },
      submit: { type: 'plain_text', text: 'Submit' },
      close: { type: 'plain_text', text: 'Back' },
      private_metadata: args.privateMeta,
      blocks: [
        header,
        {
          type: 'input',
          block_id: blockId('review', 'strengths'),
          label: { type: 'plain_text', text: 'Strengths' },
          element: {
            type: 'plain_text_input',
            action_id: 'strengths',
            multiline: true,
            initial_value: values.strengths,
          },
        },
        {
          type: 'input',
          block_id: blockId('review', 'development_areas'),
          label: { type: 'plain_text', text: 'Primary development areas' },
          element: {
            type: 'plain_text_input',
            action_id: 'development_areas',
            multiline: true,
            initial_value: values.developmentAreas,
          },
        },
        {
          type: 'input',
          block_id: blockId('review', 'next_cycle_expectations'),
          label: { type: 'plain_text', text: 'Expected improvements next cycle' },
          element: {
            type: 'plain_text_input',
            action_id: 'next_cycle_expectations',
            multiline: true,
            initial_value: values.nextCycleExpectations,
          },
        },
        {
          type: 'input',
          block_id: blockId('review', 'manager_support'),
          label: { type: 'plain_text', text: 'Manager support (optional)' },
          optional: true,
          element: {
            type: 'plain_text_input',
            action_id: 'manager_support',
            multiline: true,
            initial_value: values.managerSupport,
          },
        },
        ...followupBlocks,
      ],
    };
  }

  return {
    type: 'modal',
    callback_id: 'manager_review_submit',
    title: { type: 'plain_text', text: 'At Risk - Document concerns' },
    submit: { type: 'plain_text', text: 'Submit' },
    close: { type: 'plain_text', text: 'Back' },
    private_metadata: args.privateMeta,
    blocks: [
      header,
      {
        type: 'input',
        block_id: blockId('review', 'primary_concerns'),
        label: { type: 'plain_text', text: 'Primary concerns' },
        element: {
          type: 'plain_text_input',
          action_id: 'primary_concerns',
          multiline: true,
          initial_value: values.primaryConcerns,
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'communicated'),
        label: { type: 'plain_text', text: 'Has this feedback been communicated previously?' },
        element: {
          type: 'radio_buttons',
          action_id: 'communicated',
          initial_option: values.communicated
            ? {
                text: {
                  type: 'plain_text',
                  text: values.communicated === 'yes' ? 'Yes' : 'No',
                },
                value: values.communicated,
              }
            : undefined,
          options: [
            { text: { type: 'plain_text', text: 'Yes' }, value: 'yes' },
            { text: { type: 'plain_text', text: 'No' }, value: 'no' },
          ],
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'required_improvement'),
        label: { type: 'plain_text', text: 'What improvement is required?' },
        element: {
          type: 'plain_text_input',
          action_id: 'required_improvement',
          multiline: true,
          initial_value: values.requiredImprovement,
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'improvement_timeline'),
        label: { type: 'plain_text', text: 'Expected timeline for improvement' },
        element: {
          type: 'plain_text_input',
          action_id: 'improvement_timeline',
          initial_value: values.improvementTimeline,
          placeholder: { type: 'plain_text', text: 'e.g. 60 days' },
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'hr_review'),
        label: { type: 'plain_text', text: 'HR review required?' },
        element: {
          type: 'radio_buttons',
          action_id: 'hr_review',
          initial_option: values.hrReview
            ? {
                text: {
                  type: 'plain_text',
                  text: values.hrReview === 'yes' ? 'Yes' : 'No',
                },
                value: values.hrReview,
              }
            : undefined,
          options: [
            { text: { type: 'plain_text', text: 'Yes' }, value: 'yes' },
            { text: { type: 'plain_text', text: 'No' }, value: 'no' },
          ],
        },
      },
      ...followupBlocks,
    ],
  };
}

export async function openWriteReviewModal(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();

  const slackUserId = body.user?.id ?? '';
  const employee = await getEmployeeForSlackUser(slackUserId);
  if (!employee) {
    await client.views.open({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Performance Review' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "You're not in the employee directory. Ask your admin to add you.",
            },
          },
        ],
      },
    });
    return;
  }

  const reports = await getDirectReports(employee.id);
  const cycle = await getActiveCycle();

  if (!cycle) {
    await client.views.open({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Performance Review' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'No active review cycle. Ask HR to open a cycle.',
            },
          },
        ],
      },
    });
    return;
  }

  const reportOptions = reports.slice(0, MAX_EMPLOYEES_IN_DROPDOWN).map((report) => ({
    text: { type: 'plain_text' as const, text: report.name },
    value: report.id,
  }));

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      callback_id: 'manager_review_step1',
      title: { type: 'plain_text', text: 'Performance Review' },
      submit: { type: 'plain_text', text: 'Next' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({ cycle_id: cycle.id, cycle_name: cycle.name }),
      blocks: [
        {
          type: 'input',
          block_id: blockId('review', 'employee'),
          label: { type: 'plain_text', text: 'Employee' },
          element: {
            type: 'static_select',
            action_id: 'employee_select',
            placeholder: { type: 'plain_text', text: 'Select employee' },
            options: reportOptions,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Review cycle:* ${cycle.name}`,
          },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*How is this employee doing?*' },
        },
        {
          type: 'actions',
          block_id: blockId('review', 'status'),
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Doing Great / On Track', emoji: true },
              action_id: 'status_on_track',
              value: 'on_track',
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Needs Focus', emoji: true },
              action_id: 'status_needs_focus',
              value: 'needs_focus',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'At Risk', emoji: true },
              action_id: 'status_at_risk',
              value: 'at_risk',
              style: 'danger',
            },
          ],
        },
      ],
    },
  });
}

export async function handleReviewStatusChoice(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();

  const statusValue = (action as { value?: string }).value as ReviewStatus | undefined;
  if (!statusValue || !body.view) return;

  const meta = body.view.private_metadata ? JSON.parse(body.view.private_metadata) : {};
  const cycleId = meta.cycle_id;
  const cycleName = meta.cycle_name ?? 'Current cycle';
  const stateValues = body.view.state?.values ?? {};
  const employeeBlockId = Object.keys(stateValues).find((key) => key.includes('employee'));
  const employeeSelect = employeeBlockId
    ? stateValues[employeeBlockId]?.employee_select?.selected_option?.value
    : null;
  const employeeId = employeeSelect ?? meta.employee_id;

  if (!cycleId || !employeeId) {
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Performance Review' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Please select an employee first, then choose how they are doing.',
            },
          },
        ],
      },
    });
    return;
  }

  const employee = await getEmployeeById(employeeId);
  const existing = await getManagerReview(cycleId, employeeId);
  if (existing) {
    await client.views.push({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Already submitted' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `A review for ${employee?.name ?? 'this employee'} has already been submitted for this cycle.`,
            },
          },
        ],
      },
    });
    return;
  }

  await client.views.push({
    trigger_id: body.trigger_id!,
    view: buildManagerReviewView({
      status: statusValue,
      employeeName: employee?.name ?? '-',
      cycleName,
      privateMeta: JSON.stringify({
        cycle_id: cycleId,
        cycle_name: cycleName,
        employee_id: employeeId,
        status: statusValue,
      }),
    }),
  });
}

export async function handleManagerReviewSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const view = args.view;
  if (!view) return;

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const {
    cycle_id: cycleId,
    cycle_name: cycleName,
    employee_id: employeeId,
    status,
    followup_stage: followupStage,
    followup_questions: followupQuestions,
  } = meta;
  const manager = await getEmployeeForSlackUser(args.body.user.id);
  if (!manager || !cycleId || !employeeId || !status) return;

  const state = (view.state?.values ?? {}) as ReviewFormState;
  const values = collectManagerDraftValues(state);
  const employee = await getEmployeeById(employeeId);

  if (!followupStage) {
    const coach = await maybeGenerateFollowupQuestions({
      flow: 'manager_review',
      subjectName: employee?.name ?? 'Employee',
      cycleName: cycleName ?? 'Current cycle',
      status,
      answers: [
        { label: 'Strengths', value: values.strengths },
        { label: 'Focus areas', value: values.focusAreas },
        { label: 'Examples', value: values.examples },
        { label: 'Development areas', value: values.developmentAreas },
        { label: 'Next cycle expectations', value: values.nextCycleExpectations },
        { label: 'Manager support', value: values.managerSupport },
        { label: 'Primary concerns', value: values.primaryConcerns },
        { label: 'Required improvement', value: values.requiredImprovement },
        { label: 'Improvement timeline', value: values.improvementTimeline },
      ],
    });

    if (coach.needsFollowup) {
      await args.ack({
        response_action: 'update',
        view: buildManagerReviewView({
          status: status as ReviewStatus,
          employeeName: employee?.name ?? '-',
          cycleName: cycleName ?? 'Current cycle',
          privateMeta: JSON.stringify({
            cycle_id: cycleId,
            cycle_name: cycleName,
            employee_id: employeeId,
            status,
            followup_stage: true,
            followup_questions: coach.questions,
          }),
          values,
          followupQuestions: coach.questions,
        }),
      });
      return;
    }
  }

  await args.ack();

  const review = await saveManagerReview(cycleId, employeeId, manager.id, {
    status: status as ReviewStatus,
    strengths: values.strengths,
    focus_areas: values.focusAreas,
    examples: values.examples,
    development_areas: values.developmentAreas,
    next_cycle_expectations: values.nextCycleExpectations,
    manager_support: values.managerSupport,
    primary_concerns: values.primaryConcerns,
    communicated_previously: values.communicated === 'yes',
    required_improvement: values.requiredImprovement,
    improvement_timeline: values.improvementTimeline,
    hr_review_required: values.hrReview === 'yes',
    follow_up_notes: formatFollowupNotes(
      Array.isArray(followupQuestions) ? followupQuestions : [],
      values.followupAnswers ?? []
    ),
  });

  await logAudit({
    entity_type: 'manager_review',
    entity_id: review.id,
    action: 'submit',
    actor_id: manager.id,
    actor_slack_id: args.body.user.id,
    details: { cycle_id: cycleId, employee_id: employeeId, status },
  });

  const employeeSlackId = employee?.slack_id;
  if (employeeSlackId) {
    await args.client.chat.postMessage({
      channel: employeeSlackId,
      text: 'Your manager completed your performance review.',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Your manager completed your performance review.',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'View review', emoji: true },
              action_id: 'view_my_review',
              value: `${cycleId}#${employeeId}`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Acknowledge', emoji: true },
              action_id: 'acknowledge_review',
              value: `${cycleId}#${employeeId}`,
            },
          ],
        },
      ],
    });
  }

  const cycleRecord = await getCycleById(cycleId);
  if (cycleRecord) {
    await generateAndStoreManagerReview(review, cycleRecord.name).catch((error) =>
      console.error('Document persistence failed:', error)
    );
  }
}
