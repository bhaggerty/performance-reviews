# DynamoDB Single-Table Design

This file described the original MVP's key design. It is now superseded by
[`docs/DATA_MODEL.md`](../../docs/DATA_MODEL.md), which documents the actual, current key
schema for every entity in `src/db/*.ts` (Employee, EmployeeIdentity, ReviewCycle,
SelfReflection, PeerRequest/PeerFeedback, UpwardFeedback/UpwardFeedbackRelease, ManagerReview
(versioned), PeopleNote, Approval, ReviewRelease, Acknowledgement, Document, AuditEvent,
OutboxJob, IdempotencyRecord, DirectoryImport, NotificationRecord, WebSession) — see that file
for PK/SK/GSI1/GSI2 patterns and the query each one supports.

Kept here only so old links into this path still resolve.
