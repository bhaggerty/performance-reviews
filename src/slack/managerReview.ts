import type {
  AllMiddlewareArgs,
  BlockAction,
  SlackActionMiddlewareArgs,
  SlackViewMiddlewareArgs,
  ViewSubmitAction,
} from '@slack/bolt';
import type { KnownBlock, View } from '@slack/types';
import { getActorForSlackUser } from './middleware';
import { getDirectReports, getEmployeeById } from '../db/employees';
import { getActiveCycle } from '../db/cycles';
import {
  getManagerReview,
  saveManagerReviewDraft,
  submitManagerReview,
  type ManagerReviewDraftInput,
} from '../db/reviews';
import { logAudit } from '../db/audit';
import { requireCurrentManagerRelationship } from '../domain/authz';
import { requireCyclePhase } from '../domain/cycleStateMachine';
import { claimSlackDelivery } from './idempotency';
import { reviewCoach } from '../services/reviewCoach';
import { escapeMrkdwn } from '../domain/slackFormat';
import type { AtRiskDetails, ReviewStatus } from '../types';

const MAX_EMPLOYEES_IN_DROPDOWN = 100;

type ReviewFormState = Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>;

function blockId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts].join('::');
}

function getVal(state: ReviewFormState, blockKey: string, actionKey: string): string | undefined {
  for (const key of Object.keys(state)) {
    if (!key.includes(blockKey)) continue;
    const value = state[key]?.[actionKey];
    if (value?.value) return value.value;
    if (value?.selected_option?.value) return value.selected_option.value;
  }
  return undefined;
}

function collectDraft(state: ReviewFormState): ManagerReviewDraftInput & { status: ReviewStatus } {
  const status = (getVal(state, 'status_hidden', 'status') ?? 'on_track') as ReviewStatus;
  const atRisk: AtRiskDetails = {
    concrete_examples: getVal(state, 'concrete_examples', 'concrete_examples'),
    prior_communication: getVal(state, 'prior_communication', 'prior_communication'),
    support_provided: getVal(state, 'support_provided', 'support_provided'),
    expected_improvement: getVal(state, 'expected_improvement', 'expected_improvement'),
    timeline: getVal(state, 'timeline', 'timeline'),
    people_involvement: getVal(state, 'people_involvement', 'people_involvement'),
  };
  return {
    status,
    strengths: getVal(state, 'strengths', 'strengths'),
    focus_areas: getVal(state, 'focus_areas', 'focus_areas'),
    examples: getVal(state, 'examples', 'examples'),
    development_areas: getVal(state, 'development_areas', 'development_areas'),
    next_cycle_expectations: getVal(state, 'next_cycle_expectations', 'next_cycle_expectations'),
    manager_support: getVal(state, 'manager_support', 'manager_support'),
    at_risk: status === 'at_risk' ? atRisk : undefined,
  };
}

function aiCoachButton(): KnownBlock {
  return {
    type: 'actions',
    block_id: 'review::ai_coach_actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Get AI feedback (optional)', emoji: true },
        action_id: 'review_ai_coach',
      },
    ],
  };
}

function aiSuggestionsBlock(questions: string[]): KnownBlock[] {
  if (!questions.length) {
    return [
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'AI coach: this draft looks sufficiently specific.' }] },
    ];
  }
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*AI coach suggestions* (optional — edit your answers above, then submit):\n${questions.map((q) => `• ${escapeMrkdwn(q)}`).join('\n')}`,
      },
    },
  ];
}

function buildManagerReviewView(args: {
  status: ReviewStatus;
  employeeName: string;
  cycleName: string;
  privateMeta: string;
  values?: Partial<ManagerReviewDraftInput>;
  submitMode?: 'draft' | 'submit';
  aiSuggestions?: string[];
}): View {
  const v = args.values ?? {};
  const header: KnownBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Employee:* ${escapeMrkdwn(args.employeeName)}\n*Cycle:* ${escapeMrkdwn(args.cycleName)}`,
    },
  };
  const modeBlock: KnownBlock = {
    type: 'input',
    block_id: 'review::mode',
    label: { type: 'plain_text', text: 'When you click Submit' },
    element: {
      type: 'radio_buttons',
      action_id: 'mode',
      initial_option: {
        text: { type: 'plain_text', text: args.submitMode === 'submit' ? 'Submit final review' : 'Save as draft' },
        value: args.submitMode ?? 'draft',
      },
      options: [
        { text: { type: 'plain_text', text: 'Save as draft (come back later)' }, value: 'draft' },
        { text: { type: 'plain_text', text: 'Submit final review' }, value: 'submit' },
      ],
    },
  };
  const aiBlocks = args.aiSuggestions ? aiSuggestionsBlock(args.aiSuggestions) : [];

  const common: KnownBlock[] = [header, aiCoachButton(), ...aiBlocks];

  if (args.status === 'on_track') {
    return {
      type: 'modal',
      callback_id: 'manager_review_submit',
      title: { type: 'plain_text', text: 'Doing Great' },
      submit: { type: 'plain_text', text: 'Save' },
      close: { type: 'plain_text', text: 'Back' },
      private_metadata: args.privateMeta,
      blocks: [
        ...common,
        {
          type: 'input',
          block_id: blockId('review', 'strengths'),
          optional: true,
          label: { type: 'plain_text', text: 'What is going well? (required to submit)' },
          element: { type: 'plain_text_input', action_id: 'strengths', multiline: true, initial_value: v.strengths },
        },
        {
          type: 'input',
          block_id: blockId('review', 'focus_areas'),
          optional: true,
          label: { type: 'plain_text', text: 'What should they keep focusing on? (required to submit)' },
          element: {
            type: 'plain_text_input',
            action_id: 'focus_areas',
            multiline: true,
            initial_value: v.focus_areas,
          },
        },
        {
          type: 'input',
          block_id: blockId('review', 'examples'),
          label: { type: 'plain_text', text: 'Examples of impact (optional)' },
          optional: true,
          element: { type: 'plain_text_input', action_id: 'examples', multiline: true, initial_value: v.examples },
        },
        modeBlock,
      ],
    };
  }

  if (args.status === 'needs_focus') {
    return {
      type: 'modal',
      callback_id: 'manager_review_submit',
      title: { type: 'plain_text', text: 'Needs Focus' },
      submit: { type: 'plain_text', text: 'Save' },
      close: { type: 'plain_text', text: 'Back' },
      private_metadata: args.privateMeta,
      blocks: [
        ...common,
        {
          type: 'input',
          block_id: blockId('review', 'strengths'),
          optional: true,
          label: { type: 'plain_text', text: 'Strengths (required to submit)' },
          element: { type: 'plain_text_input', action_id: 'strengths', multiline: true, initial_value: v.strengths },
        },
        {
          type: 'input',
          block_id: blockId('review', 'development_areas'),
          optional: true,
          label: { type: 'plain_text', text: 'Primary development areas (required to submit)' },
          element: {
            type: 'plain_text_input',
            action_id: 'development_areas',
            multiline: true,
            initial_value: v.development_areas,
          },
        },
        {
          type: 'input',
          block_id: blockId('review', 'next_cycle_expectations'),
          optional: true,
          label: { type: 'plain_text', text: 'Expected improvements next cycle (required to submit)' },
          element: {
            type: 'plain_text_input',
            action_id: 'next_cycle_expectations',
            multiline: true,
            initial_value: v.next_cycle_expectations,
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
            initial_value: v.manager_support,
          },
        },
        modeBlock,
      ],
    };
  }

  const atRisk = v.at_risk ?? {};
  return {
    type: 'modal',
    callback_id: 'manager_review_submit',
    title: { type: 'plain_text', text: 'At Risk' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Back' },
    private_metadata: args.privateMeta,
    blocks: [
      ...common,
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Use factual, behavior-based descriptions. This flow does not draw legal conclusions.',
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'concrete_examples'),
        optional: true,
        label: { type: 'plain_text', text: 'Concrete examples (required to submit)' },
        element: {
          type: 'plain_text_input',
          action_id: 'concrete_examples',
          multiline: true,
          initial_value: atRisk.concrete_examples,
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'prior_communication'),
        optional: true,
        label: { type: 'plain_text', text: 'Prior communication with the employee (required to submit)' },
        element: {
          type: 'plain_text_input',
          action_id: 'prior_communication',
          multiline: true,
          initial_value: atRisk.prior_communication,
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'support_provided'),
        optional: true,
        label: { type: 'plain_text', text: 'Support already provided (required to submit)' },
        element: {
          type: 'plain_text_input',
          action_id: 'support_provided',
          multiline: true,
          initial_value: atRisk.support_provided,
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'expected_improvement'),
        optional: true,
        label: { type: 'plain_text', text: 'Expected improvement (required to submit)' },
        element: {
          type: 'plain_text_input',
          action_id: 'expected_improvement',
          multiline: true,
          initial_value: atRisk.expected_improvement,
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'timeline'),
        optional: true,
        label: { type: 'plain_text', text: 'Timeline (required to submit)' },
        element: {
          type: 'plain_text_input',
          action_id: 'timeline',
          initial_value: atRisk.timeline,
          placeholder: { type: 'plain_text', text: 'e.g. 60 days' },
        },
      },
      {
        type: 'input',
        block_id: blockId('review', 'people_involvement'),
        label: { type: 'plain_text', text: 'People/HR involvement so far' },
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'people_involvement',
          multiline: true,
          initial_value: atRisk.people_involvement,
        },
      },
      modeBlock,
    ],
  };
}

export async function openWriteReviewModal(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.();
  const triggerId = body.trigger_id;
  const actor = await getActorForSlackUser(body.user?.id);
  if (!actor) {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal('Performance Review', "You're not in the employee directory."),
    });
    return;
  }
  const cycle = await getActiveCycle();
  if (!cycle) {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal('Performance Review', 'No active review cycle.'),
    });
    return;
  }
  try {
    requireCyclePhase(cycle.status, 'manager_review_edit');
  } catch {
    await client.views.open({
      trigger_id: triggerId,
      view: infoModal('Performance Review', `Manager reviews are not open yet (cycle phase: ${cycle.status}).`),
    });
    return;
  }

  const reports = await getDirectReports(actor.employee.id);
  const reportOptions = reports
    .slice(0, MAX_EMPLOYEES_IN_DROPDOWN)
    .map((r) => ({ text: { type: 'plain_text' as const, text: r.name }, value: r.id }));

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      // No `submit` button on purpose: this step has no registered view_submission handler.
      // The only way to proceed is one of the status buttons below, which push the next modal.
      title: { type: 'plain_text', text: 'Performance Review' },
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
          text: { type: 'mrkdwn', text: '*How is this employee doing?* Select them above, then choose a status.' },
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

function infoModal(title: string, text: string): View {
  return {
    type: 'modal',
    title: { type: 'plain_text', text: title.slice(0, 24) },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
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
  const employeeId = employeeBlockId
    ? stateValues[employeeBlockId]?.employee_select?.selected_option?.value
    : undefined;
  if (!cycleId || !employeeId) return;

  const manager = await getActorForSlackUser(body.user?.id);
  if (!manager) return;

  let employee;
  try {
    employee = await requireCurrentManagerRelationship(manager.employee.id, employeeId);
  } catch {
    await client.views.update({
      view_id: body.view.id,
      view: infoModal('Not allowed', 'This person is not currently one of your direct reports.'),
    });
    return;
  }

  const existing = await getManagerReview(cycleId, employeeId);
  const editable =
    !existing || ['not_submitted', 'manager_draft', 'returned_to_manager'].includes(existing.people_state);
  if (existing && !editable) {
    await client.views.push({
      trigger_id: body.trigger_id,
      view: infoModal(
        'Already submitted',
        `A review for ${employee.name} has already been submitted for this cycle and is with People Ops.`
      ),
    });
    return;
  }

  await client.views.push({
    trigger_id: body.trigger_id,
    view: buildManagerReviewView({
      status: statusValue,
      employeeName: employee.name,
      cycleName,
      privateMeta: JSON.stringify({
        cycle_id: cycleId,
        cycle_name: cycleName,
        employee_id: employeeId,
        status: statusValue,
      }),
      values: existing ?? undefined,
      submitMode: 'draft',
    }),
  });
}

export async function handleAiCoachRequest(
  args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs
): Promise<void> {
  const { body, client, ack } = args;
  await ack?.(); // ack the button click immediately; the AI call happens after, off the interaction deadline
  if (!body.view) return;
  const meta = JSON.parse(body.view.private_metadata || '{}');
  const state = (body.view.state?.values ?? {}) as ReviewFormState;
  const draft = collectDraft(state);
  const employee = await getEmployeeById(meta.employee_id);

  const result = await reviewCoach.reviewDraft({
    flow: 'manager_review',
    subjectName: employee?.name ?? 'Employee',
    cycleName: meta.cycle_name ?? 'Current cycle',
    status: draft.status,
    answers: [
      { label: 'Strengths', value: draft.strengths },
      { label: 'Focus areas', value: draft.focus_areas },
      { label: 'Development areas', value: draft.development_areas },
      { label: 'Concrete examples', value: draft.at_risk?.concrete_examples },
    ],
  });

  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: buildManagerReviewView({
      status: draft.status,
      employeeName: employee?.name ?? '-',
      cycleName: meta.cycle_name ?? 'Current cycle',
      privateMeta: body.view.private_metadata,
      values: draft,
      submitMode:
        (state['review::mode']?.mode as { selected_option?: { value?: string } })?.selected_option?.value === 'submit'
          ? 'submit'
          : 'draft',
      aiSuggestions: result.questions,
    }),
  });
}

const REQUIRED_FIELDS_BY_STATUS: Record<
  ReviewStatus,
  Array<{ key: keyof ManagerReviewDraftInput | `at_risk.${keyof AtRiskDetails}`; block: string }>
> = {
  on_track: [
    { key: 'strengths', block: blockId('review', 'strengths') },
    { key: 'focus_areas', block: blockId('review', 'focus_areas') },
  ],
  needs_focus: [
    { key: 'strengths', block: blockId('review', 'strengths') },
    { key: 'development_areas', block: blockId('review', 'development_areas') },
    { key: 'next_cycle_expectations', block: blockId('review', 'next_cycle_expectations') },
  ],
  at_risk: [
    { key: 'at_risk.concrete_examples', block: blockId('review', 'concrete_examples') },
    { key: 'at_risk.prior_communication', block: blockId('review', 'prior_communication') },
    { key: 'at_risk.support_provided', block: blockId('review', 'support_provided') },
    { key: 'at_risk.expected_improvement', block: blockId('review', 'expected_improvement') },
    { key: 'at_risk.timeline', block: blockId('review', 'timeline') },
  ],
};

function validateRequiredFields(draft: ManagerReviewDraftInput & { status: ReviewStatus }): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of REQUIRED_FIELDS_BY_STATUS[draft.status]) {
    const value = field.key.startsWith('at_risk.')
      ? draft.at_risk?.[field.key.split('.')[1] as keyof AtRiskDetails]
      : draft[field.key as keyof ManagerReviewDraftInput];
    if (!(typeof value === 'string' ? value.trim() : value)) {
      errors[field.block] = 'This field is required to submit a final review.';
    }
  }
  return errors;
}

export async function handleManagerReviewSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  const { view, body } = args;
  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { cycle_id: cycleId, employee_id: employeeId } = meta;
  const manager = await getActorForSlackUser(body.user.id);
  if (!manager || !cycleId || !employeeId) {
    await args.ack();
    return;
  }

  const state = (view.state?.values ?? {}) as ReviewFormState;
  const draft = collectDraft(state);
  const mode =
    (state['review::mode']?.mode as { selected_option?: { value?: string } })?.selected_option?.value ?? 'draft';

  try {
    await requireCurrentManagerRelationship(manager.employee.id, employeeId);
    const cycle = await getActiveCycle();
    if (!cycle || cycle.id !== cycleId) throw new Error('Cycle is no longer active.');
    requireCyclePhase(cycle.status, 'manager_review_edit');
  } catch (error) {
    await args.ack({
      response_action: 'errors',
      errors: { [blockId('review', 'strengths')]: error instanceof Error ? error.message : 'Not allowed.' },
    });
    return;
  }

  // Deterministic, immediate validation of required-for-submission fields — returned
  // synchronously from ack() so Slack shows inline errors without any write happening.
  if (mode === 'submit') {
    const errors = validateRequiredFields(draft);
    if (Object.keys(errors).length > 0) {
      await args.ack({ response_action: 'errors', errors });
      return;
    }
  }

  // Idempotency is claimed only after every validation check passes, so retrying after a
  // validation error is never mistaken for a duplicate delivery of a valid submission.
  const isFirst = await claimSlackDelivery('manager_review_submit', body);
  if (!isFirst) {
    await args.ack();
    return;
  }

  await args.ack();

  try {
    if (mode === 'submit') {
      await submitManagerReview(cycleId, employeeId, manager.employee.id, draft);
      await logAudit({
        entity_type: 'manager_review',
        entity_id: employeeId,
        action: 'submit',
        actor_id: manager.employee.id,
        actor_slack_id: body.user.id,
        cycle_id: cycleId,
        manager_id: manager.employee.id,
      });
    } else {
      await saveManagerReviewDraft(cycleId, employeeId, manager.employee.id, draft);
      await logAudit({
        entity_type: 'manager_review',
        entity_id: employeeId,
        action: 'save_draft',
        actor_id: manager.employee.id,
        actor_slack_id: body.user.id,
        cycle_id: cycleId,
        manager_id: manager.employee.id,
      });
    }
  } catch (error) {
    // Submission raced with another attempt, or the review was returned/reopened concurrently.
    // Nothing further to notify here — the manager will see the current state next time they open the modal.
    void error;
  }
}
