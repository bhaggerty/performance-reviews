import type { AllMiddlewareArgs, SlackActionMiddlewareArgs, SlackViewMiddlewareArgs, BlockAction, ViewSubmitAction } from '@slack/bolt';
import { getEmployeeForSlackUser } from './middleware';
import { getDirectReports, getEmployeeById } from '../db/employees';
import { getActiveCycle, listCycles, getCycleById } from '../db/cycles';
import { saveManagerReview, getManagerReview } from '../db/reviews';
import { logAudit } from '../db/audit';
import { generateAndStoreManagerReview } from '../services/documents';
import type { ReviewStatus } from '../types';

const MAX_EMPLOYEES_IN_DROPDOWN = 100;

function blockId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts].join('::');
}

export async function openWriteReviewModal(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
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
  const cycles = await listCycles();

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

  const reportOptions = reports.slice(0, MAX_EMPLOYEES_IN_DROPDOWN).map((r) => ({
    text: { type: 'plain_text' as const, text: r.name },
    value: r.id,
  }));

  await client.views.open({
    trigger_id: body.trigger_id!,
    view: {
      type: 'modal',
      callback_id: 'manager_review_step1',
      title: { type: 'plain_text', text: 'Performance Review' },
      submit: { type: 'plain_text', text: 'Next' },
      close: { type: 'plain_text', text: 'Cancel' },
      private_metadata: JSON.stringify({ cycle_id: cycle.id }),
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

// When manager clicks a status button we open the path-specific modal (we need employee from the modal state)
// Bolt doesn't give us the current modal state in block_actions from the same modal. So we have to either:
// (1) Require they select employee first then click status - but then we don't have the selected employee in the action.
// So we need to get the selected value from the view when they click. We can use view.state.values in the action handler.
// Actually in block_actions for a modal, we get body.view with state.values. So we can read the employee dropdown value and the clicked button value.
export async function handleReviewStatusChoice(args: SlackActionMiddlewareArgs<BlockAction> & AllMiddlewareArgs): Promise<void> {
  const { body, client, ack, action } = args;
  await ack?.();

  const actionId = action.action_id;
  const statusValue = (action as { value?: string }).value as ReviewStatus | undefined;
  if (!statusValue || !body.view) return;

  const meta = body.view.private_metadata ? JSON.parse(body.view.private_metadata) : {};
  const cycleId = meta.cycle_id;
  const stateValues = body.view.state?.values ?? {};
  const employeeBlockId = Object.keys(stateValues).find((k) => k.includes('employee'));
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

  const emp = await getEmployeeById(employeeId);
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
              text: `A review for ${emp?.name ?? 'this employee'} has already been submitted for this cycle.`,
            },
          },
        ],
      },
    });
    return;
  }

  const cycle = meta.cycle_name ?? 'Current cycle';
  const privateMeta = JSON.stringify({ cycle_id: cycleId, employee_id: employeeId, status: statusValue });

  if (statusValue === 'on_track') {
    await client.views.push({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        callback_id: 'manager_review_submit',
        title: { type: 'plain_text', text: 'Doing Great — Quick feedback' },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Back' },
        private_metadata: privateMeta,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*Employee:* ${emp?.name ?? '—'}\n*Cycle:* ${cycle}` } },
          {
            type: 'input',
            block_id: blockId('review', 'strengths'),
            label: { type: 'plain_text', text: 'What is going well?' },
            element: {
              type: 'plain_text_input',
              action_id: 'strengths',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'e.g. Strong execution, great collaboration' },
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
              placeholder: { type: 'plain_text', text: 'e.g. Continue scaling automation' },
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
            },
          },
        ],
      },
    });
    return;
  }

  if (statusValue === 'needs_focus') {
    await client.views.push({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        callback_id: 'manager_review_submit',
        title: { type: 'plain_text', text: 'Needs Focus — Development areas' },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Back' },
        private_metadata: privateMeta,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*Employee:* ${emp?.name ?? '—'}\n*Cycle:* ${cycle}` } },
          {
            type: 'input',
            block_id: blockId('review', 'strengths'),
            label: { type: 'plain_text', text: 'Strengths' },
            element: {
              type: 'plain_text_input',
              action_id: 'strengths',
              multiline: true,
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
            },
          },
        ],
      },
    });
    return;
  }

  if (statusValue === 'at_risk') {
    await client.views.push({
      trigger_id: body.trigger_id!,
      view: {
        type: 'modal',
        callback_id: 'manager_review_submit',
        title: { type: 'plain_text', text: 'At Risk — Document concerns' },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Back' },
        private_metadata: privateMeta,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*Employee:* ${emp?.name ?? '—'}\n*Cycle:* ${cycle}` } },
          {
            type: 'input',
            block_id: blockId('review', 'primary_concerns'),
            label: { type: 'plain_text', text: 'Primary concerns' },
            element: {
              type: 'plain_text_input',
              action_id: 'primary_concerns',
              multiline: true,
            },
          },
          {
            type: 'input',
            block_id: blockId('review', 'communicated'),
            label: { type: 'plain_text', text: 'Has this feedback been communicated previously?' },
            element: {
              type: 'radio_buttons',
              action_id: 'communicated',
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
            },
          },
          {
            type: 'input',
            block_id: blockId('review', 'improvement_timeline'),
            label: { type: 'plain_text', text: 'Expected timeline for improvement' },
            element: {
              type: 'plain_text_input',
              action_id: 'improvement_timeline',
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
}

function getValFromState(
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

export async function handleManagerReviewSubmit(
  args: SlackViewMiddlewareArgs<ViewSubmitAction> & AllMiddlewareArgs
): Promise<void> {
  await args.ack();
  const view = args.view;
  if (!view) return;

  const meta = JSON.parse(view.private_metadata ?? '{}');
  const { cycle_id: cycleId, employee_id: employeeId, status } = meta;
  const manager = await getEmployeeForSlackUser(args.body.user.id);
  if (!manager || !cycleId || !employeeId || !status) return;

  const state = (view.state?.values ?? {}) as Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>;
  const getVal = (blockKey: string, actionKey: string) => getValFromState(state, blockKey, actionKey);

  const strengths = getVal('strengths', 'strengths');
  const focus_areas = getVal('focus_areas', 'focus_areas');
  const examples = getVal('examples', 'examples');
  const development_areas = getVal('development_areas', 'development_areas');
  const next_cycle_expectations = getVal('next_cycle_expectations', 'next_cycle_expectations');
  const manager_support = getVal('manager_support', 'manager_support');
  const primary_concerns = getVal('primary_concerns', 'primary_concerns');
  const communicated = getVal('communicated', 'communicated');
  const required_improvement = getVal('required_improvement', 'required_improvement');
  const improvement_timeline = getVal('improvement_timeline', 'improvement_timeline');
  const hr_review = getVal('hr_review', 'hr_review');

  const review = await saveManagerReview(cycleId, employeeId, manager.id, {
    status: status as ReviewStatus,
    strengths,
    focus_areas,
    examples,
    development_areas,
    next_cycle_expectations,
    manager_support,
    primary_concerns,
    communicated_previously: communicated === 'yes',
    required_improvement,
    improvement_timeline,
    hr_review_required: hr_review === 'yes',
  });

  await logAudit({
    entity_type: 'manager_review',
    entity_id: review.id,
    action: 'submit',
    actor_id: manager.id,
    actor_slack_id: args.body.user.id,
    details: { cycle_id: cycleId, employee_id: employeeId, status },
  });

  // Modal closes on successful ack; no need to call views.close

  const emp = await getEmployeeById(employeeId);
  const empSlackId = emp?.slack_id;
  if (empSlackId) {
    await args.client.chat.postMessage({
      channel: empSlackId,
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
  if (cycleRecord)
    await generateAndStoreManagerReview(review, cycleRecord.name).catch((err) =>
      console.error('Document upload failed:', err)
    );
}
