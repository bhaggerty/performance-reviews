# Google Drive Archive

This app can mirror canonical review documents to a private archive by calling a webhook after each document is created. The app already supports this through:

- `DOCUMENT_ARCHIVE_WEBHOOK_URL`
- `DOCUMENT_ARCHIVE_WEBHOOK_SECRET`

The recommended private archive implementation is Google Apps Script writing into a locked-down shared drive or folder owned by HR.

## What the app sends

The app makes a `POST` request with:

- `Content-Type: application/json`

Request body:

```json
{
  "shared_secret": "same-secret-as-your-script-property",
  "document_type": "manager_review",
  "title": "2026-H1 performance review for Blake Haggerty",
  "content": "Performance Review\nEmployee: Blake Haggerty\n...",
  "cycle_name": "2026-H1",
  "employee_name": "Blake Haggerty",
  "employee_id": "employee-uuid",
  "author_employee_id": "manager-uuid",
  "visibility": "employee_and_manager",
  "archive_paths": {
    "employeeFolder": "Blake Haggerty",
    "cycleFolder": "2026-H1",
    "fileName": "Blake Haggerty-manager-review-2026-03-15.txt"
  }
}
```

## What the webhook should return

Return JSON with either of these:

```json
{
  "archiveUrl": "https://drive.google.com/file/d/FILE_ID/view",
  "archiveKey": "FILE_ID"
}
```

or

```json
{
  "fileUrl": "https://drive.google.com/file/d/FILE_ID/view",
  "fileId": "FILE_ID"
}
```

The app stores those values in DynamoDB alongside the canonical document snapshot.

## Recommended Drive layout

Use an HR-only root folder or shared drive and create:

- `Employees/<Employee Name>/Performance Reviews/<Cycle>/...`
- `<Cycle>/Manager Reviews/...`
- `<Cycle>/Peer Feedback/...`
- `<Cycle>/Upward Feedback/...`

This mirrors the app's archive path model while keeping access private to HR.

## Apps Script deployment

Use [scripts/google-drive-archive.gs](C:\Users\marli\performance-reviews\scripts\google-drive-archive.gs) as the starting point.

Suggested script properties:

- `ARCHIVE_SECRET`: same value as `DOCUMENT_ARCHIVE_WEBHOOK_SECRET`
- `HR_ROOT_FOLDER_ID`: Google Drive folder ID for the HR-private root

Deploy as:

1. New Apps Script project
2. Paste the script contents
3. Set Script Properties
4. Deploy as Web App
5. Execute as the script owner
6. Limit access according to your org's policy

Then set:

- `DOCUMENT_ARCHIVE_WEBHOOK_URL` to the web app URL
- `DOCUMENT_ARCHIVE_WEBHOOK_SECRET` to the shared secret

## Security note

Managers and employees should reference reviews through the app, not direct Drive permissions. The app already stores canonical content snapshots in DynamoDB and can authorize who sees what. The Drive archive should stay private to HR.
