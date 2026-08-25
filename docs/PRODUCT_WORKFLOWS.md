# Product Workflows

All Slack-native flows re-derive the actor and every relationship from the live `Employee` record
on every sensitive action (`src/domain/authz.ts`) — nothing in Slack `private_metadata` or a
button `value` is trusted as authorization, only as a lookup key.

## Cycle phases

A `ReviewCycle` (`src/types.ts`) moves through an explicit state machine
(`src/domain/cycleStateMachine.ts`, enforced by `src/db/cycles.ts#transitionCycle`):

```
draft → collecting_feedback → manager_reviews → people_review → released → closed
  ↓            ↓                    ↓                ↓
cancelled   cancelled            cancelled        cancelled
```

Only one cycle may hold `collecting_feedback` / `manager_reviews` / `people_review` / `released`
at a time (`ACTIVE_LOCK_STATUSES`, enforced via a singleton `SYSTEM#ACTIVE_CYCLE` lock record).
`draft` cycles can coexist freely — e.g. drafting next cycle's config while the current one is
still running.

Employee-facing actions are gated by phase (`ACTION_REQUIRED_PHASE` in
`cycleStateMachine.ts`): self-reflection, peer requests/feedback, and upward feedback all require
`collecting_feedback`; manager review drafting/submission requires `manager_reviews`;
acknowledgement requires `released` or `closed`.

## Self-reflection

1. Employee clicks **Self reflection** in App Home → `openSelfReflectionModal`
   (`src/slack/selfReflection.ts`) shows the cycle's configured prompts
   (`ReviewCycle.self_reflection_prompts`, defaulting to `DEFAULT_SELF_REFLECTION_PROMPTS` in
   `src/types.ts`), pre-filled from any existing draft.
2. Submitting the modal always calls `saveSelfReflectionDraft`; a radio choice
   ("Save as draft" / "Submit as final") additionally calls `submitSelfReflection` when the
   employee chose final. `SelfReflectionState` is `draft → submitted` (or `reopened`, only via a
   Primary Approver action, not yet exposed in the console UI — see `docs/GO_LIVE_CHECKLIST.md`).
3. Once `submitted`, the draft is immutable (`saveSelfReflectionDraft` throws) until reopened.
4. App Home refreshes immediately after save/submit (`refreshHomeForUser`), and the submission is
   visible to the current manager and People admins (review-detail view in the console) but not to
   any other employee.
5. Included in the final employee packet at release.

## Peer feedback

1. Employee opens **Request peer feedback** → searches colleagues via a Slack `multi_external_select`
   backed by `loadPeerOptions` (excludes self and inactive employees, no hard 100-row cap since
   it's server-searched, not a static list) → `handlePeerFeedbackRequestSubmit` creates a
   `PeerRequest` per selected peer via `createPeerRequest`, which is **idempotent by construction**
   (deterministic ID `cycleId:requesterId:peerId`) — re-requesting the same peer is a no-op, not a
   duplicate.
2. The peer gets a DM with **Accept**/**Decline** buttons. `PeerRequestStatus` moves
   `pending → accepted` or `pending → declined`; both re-verify the clicking Slack user resolves
   to `request.peer_id` (`requirePeerRequestRecipient`).
3. Accepting opens the feedback modal immediately; if closed without submitting, the request is
   **not stranded** — it stays `accepted` and reappears under **My peer requests** in App Home
   (`viewMyPeerRequests` / `handleResumePeerRequest`) until submitted.
4. Final submission (`handlePeerFeedbackSubmit`) is a conditional create in `PeerFeedback`
   (`savePeerFeedback`) — a second submission attempt is rejected, not overwritten — and flips the
   request to `submitted`. The requester gets a content-free notification ("a peer submitted
   feedback") but never sees who, and never sees the content before release.
5. **Author identity is never visible to the employee.** People admins and the current manager see
   named feedback in the review-detail view (`getPeerFeedbackForEmployee`); the employee-visible
   copy generated at submission time (`generateAndStorePeerFeedback`) never includes the author.
   People can additionally mark a specific feedback item `redacted_for_employee` with a note
   (`setPeerFeedbackRedaction`) if its content is identifying even without a name — not yet wired
   to a console button (see `docs/GO_LIVE_CHECKLIST.md`).

## Upward feedback

1. Employee opens **Give upward feedback** — the manager shown is re-resolved live from
   `actor.employee.manager_id`, never from stale metadata.
2. One immutable final submission per (cycle, employee) — `saveUpwardFeedback` is a conditional
   create; there is no draft state for upward feedback.
3. Raw `UpwardFeedback` (strengths / improvements / notes / `allow_hr_followup`) is **People-only**
   by default. It is never included in the employee's own packet, and the manager is never
   notified that it exists.
4. In the console (`docs/WEB_CONSOLE.md`), People Ops can view raw submissions for a manager
   (anonymized as `respondent-1`, `respondent-2`, ...), optionally get an AI-drafted summary
   (`draftUpwardSummary` — always editable, never released as-is), and prepare a release as one of
   four `UpwardReleaseMode`s: `none`, `summary_only`, `comments_only`, `summary_and_comments`.
5. **Fewer than 3 respondents** (`RESPONDENT_THRESHOLD` in `src/api/console/upwardFeedback.ts`)
   blocks release unless the Primary Approver supplies an explicit
   `threshold_override_reason` — this is checked server-side on the release endpoint itself, not
   just in the UI.
6. Release (`recordUpwardFeedbackRelease`) is versioned and immutable per version; only the
   **Primary Approver** can call the release endpoint
   (`requirePrimaryApproverMiddleware`). The manager only ever sees the exact released version,
   delivered via Slack, never the raw submissions.

## Manager review

1. Manager clicks **Write review** → `openWriteReviewModal` lists _current_ direct reports
   (`getDirectReports`, re-queried fresh) and the three-way decision tree: **Doing Great / On
   Track**, **Needs Focus**, **At Risk**.
2. Selecting an employee + status re-verifies `requireCurrentManagerRelationship(manager, employee)`
   before showing the path-specific form — a manager cannot open a review for someone who stopped
   reporting to them since the dropdown was rendered.
3. Each path has its own fields; **At Risk** additionally requires `AtRiskDetails`: concrete
   examples, prior communication, support already provided, expected improvement, timeline, and
   People involvement — framed as factual/behavioral, not legal conclusions.
4. An optional **Get AI feedback** button (`handleAiCoachRequest`) acks immediately, then calls
   `reviewCoach.reviewDraft()` and updates the modal with suggested follow-up questions as
   read-only text — this never blocks or gates the actual save/submit path.
5. A radio choice ("Save as draft" / "Submit final review") routes to `saveManagerReviewDraft` or
   `submitManagerReview`. Both are conditional writes keyed on the review's current `version` and
   `people_state`, so a stale double-submit (e.g. a Slack retry) cannot silently clobber a review
   someone else already returned or approved.
6. Submitting **does not notify the employee** — it only creates/updates the `submitted`
   `PeopleReviewState` and appends a `REVIEWVERSION#` history row (`persistVersion`). The employee
   learns about a review only after release.

## People review → approval → release

`PeopleReviewState` (`src/types.ts`): `not_submitted → manager_draft → submitted →
people_reviewing → returned_to_manager (loops back to manager_draft) → people_review_complete →
awaiting_primary_approval → approved → released → acknowledged`.

1. A submitted review appears in the console **Review Queue**. Any People admin can add an
   internal note (`addPeopleNote` — never shown to employee or manager), mark People review
   in-progress/complete, or **return** it to the manager with a reason (`returnToManager`) —
   the manager sees the reason and can revise; prior versions are preserved in history.
2. Any People admin may **recommend** approval (`recordApproval` with action `recommend`) — this
   moves the review to `awaiting_primary_approval` but does **not** approve or release anything.
3. Only the **Primary Approver** can call `/approve` (`requirePrimaryApproverMiddleware`), which
   records a distinct `Approval` (`primary_approve` or `at_risk_primary_approve` for At Risk
   reviews) and transitions to `approved`.
4. Only the **Primary Approver** can call `/release` or `/bulk-release`. Release generates the
   final document at that moment (`generateAndStoreManagerReview`), creates a one-time
   `ReviewRelease` record, flips `people_state` to `released`, and enqueues the employee
   notification — release and approval are always two separately recorded actions even though the
   console can drive them back to back. **Bulk release refuses any employee whose review is
   `at_risk`** — those must be released individually.

## Acknowledgement

1. Employee opens **View my review** — `requireReleasedReviewAccess` blocks access until a
   `ReviewRelease` exists for that employee/cycle.
2. **Acknowledge** opens a modal that states plainly that acknowledging confirms receipt, not
   agreement, with an optional comment field.
3. Submitting calls `createAcknowledgement` — a conditional create keyed on (cycle, employee), so
   a duplicate submit (double-click, Slack retry) returns the original record instead of
   overwriting it. Timestamp and comment are written together, atomically, and the record is a
   separate, append-only entity from `ManagerReview` — the original manager submission is never
   mutated by acknowledgement.
4. App Home refreshes, and the current manager gets a content-free "acknowledged" notification.
   Acknowledgement status is visible in the console Review Queue and Review Detail.

## Reminders

`src/services/reminders.ts` computes eligibility per `ReminderType` against an injected clock
(testable without wall-clock dependence) and enqueues idempotent, per-day-deduped
`notify_slack_dm` outbox jobs. "Routine" types (self-reflection missing, peer request pending,
peer feedback incomplete, upward feedback missing, manager review missing, released
unacknowledged) run automatically once daily via `npm run reminders:run`
(`src/jobs/runReminders.ts`) on a Union Station scheduled task. Any authorized People admin may
also trigger a send from the console (`POST /api/console/cycles/:id/reminders/:type/send`) with a
preview and an exclude-list first — see `docs/WEB_CONSOLE.md`. `people_review_waiting` and
`primary_approval_waiting` are internal-alert types (no per-employee Slack DM target) surfaced only
as counts.
