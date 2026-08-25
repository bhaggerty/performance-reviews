# Privacy and Retention

## What's retained, and where

| Data                                                                                         | Canonical store                                          | Mirror/archive                                                                                       | Retention                                                              |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Employee directory                                                                           | DynamoDB `Employee`                                      | —                                                                                                    | Until deactivated/removed by a future directory import or admin action |
| Self-reflections, manager reviews, peer feedback, upward feedback (raw)                      | DynamoDB (versioned where applicable)                    | —                                                                                                    | Indefinite, tied to the cycle                                          |
| Final documents (manager review at release, peer feedback and upward feedback at submission) | DynamoDB `DocumentRecord` (canonical, access-controlled) | S3 or a private webhook (`src/services/documents.ts`), reachable only via short-lived presigned URLs | Indefinite                                                             |
| Approvals, releases, acknowledgements                                                        | DynamoDB, append-only/conditional-create                 | —                                                                                                    | Indefinite                                                             |
| Audit events                                                                                 | DynamoDB `AuditEvent`, append-only                       | —                                                                                                    | Indefinite                                                             |
| Directory import history                                                                     | DynamoDB `DirectoryImportSummary` — **counts only**      | —                                                                                                    | Indefinite                                                             |
| Uploaded CSV file content                                                                    | **Not retained at all**                                  | —                                                                                                    | n/a                                                                    |

`src/services/directoryImport/importer.ts#commitImport` calls
`recordDirectoryImport` with created/updated/unchanged/deactivated/unresolved/warning/error
_counts_ and the actor/source — never the uploaded rows themselves. This is deliberate: enough is
kept to diagnose what an import changed, without retaining a file that may contain every
employee's PII in one place longer than necessary.

## Anonymization rules

- **Peer feedback**: the employee-visible document generated at submission
  (`generateAndStorePeerFeedback`) never includes `authorEmployeeId`. The current manager and
  People admins see named feedback in the console Review Detail view
  (`getPeerFeedbackForEmployee`) for quality/context purposes, but the employee never does. People
  can additionally flag a specific item `redacted_for_employee` with a note
  (`setPeerFeedbackRedaction`) when content is identifying even without a name attached.
- **Upward feedback**: raw submissions are People-only, always. What a manager ultimately sees is
  a separate, versioned `UpwardFeedbackRelease` record the Primary Approver explicitly created —
  never the raw rows, never author identity, and never anything below the 3-respondent threshold
  without an explicit override reason. See `docs/PRODUCT_WORKFLOWS.md` and `docs/SECURITY.md`.
- **People-only notes and approval reasoning**: `PeopleNote` and `Approval.notes` are never
  returned by any employee- or manager-facing endpoint or Slack view — only the console's
  People-admin-gated review-detail route returns them.

## Data export

Authorized exports (all under `/api/console`, all audited via `logAudit` at export time — see
`docs/WEB_CONSOLE.md` for the full route list):

- `GET /exports/employee-directory.csv` — full directory.
- `GET /cycles/:cycleId/exports/completion-report.csv` — per-employee completion status.
- `GET /cycles/:cycleId/exports/review-status.csv` — per-employee review lifecycle status.
- `GET /cycles/:cycleId/exports/upward-feedback-admin.csv` — respondent counts, threshold flags,
  and release status per manager (no raw comment text).
- `GET /employees/:employeeId/final-packet` — exactly the employee-visible document set for one
  employee (self-reflection, released manager review, anonymized peer feedback) — the same
  content boundary as the packet itself, never raw upward feedback or People-only notes.
- `GET /exports/audit-report.csv` — audit trail, filterable by actor.

## Deletion / anonymization — documented gap

**There is no deletion or anonymization command in this codebase yet.** The assignment calls for a
protected, non-automatic deletion/anonymization capability (e.g. for an offboarded employee or a
data-subject request); this pass did not implement one. Treat this as explicit future work, not an
existing-but-hidden feature:

- No endpoint, script, or console action currently deletes or anonymizes an `Employee` or their
  associated reviews/feedback/documents.
- Any future implementation should require Primary Approver authorization (consistent with every
  other consequential action in this system), operate on a specific employee by ID rather than a
  broad filter, write an audit event before performing the deletion, and very likely need to reckon
  with the fact that peer/upward feedback authored _by_ a departing employee is also referenced
  from _other_ employees' packets and release records — a straightforward hard-delete would need
  to either redact-in-place or accept that some historical documents become partially
  unreconstructable. Design this deliberately before building it; do not bolt on a quick
  `DeleteItem` loop.
- Until this exists, offboarding an employee should go through the CSV import's `status: inactive`
  path (see `docs/PRODUCT_WORKFLOWS.md`'s directory-import notes and `docs/DATA_MODEL.md`) — which
  deactivates them but does not delete or anonymize any historical data.
