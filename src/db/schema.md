# DynamoDB Single-Table Design

Table name: `DYNAMODB_TABLE` (e.g. performance-reviews)

## Keys
- **PK** (Partition Key), **SK** (Sort Key)
- **GSI1**: `GSI1PK`, `GSI1SK` — Slack ID lookup, manager's reports
- **GSI2**: `GSI2PK`, `GSI2SK` — Cycle-scoped queries

## Entity Patterns

| Entity        | PK            | SK               | GSI1PK              | GSI1SK        | GSI2PK           | GSI2SK        |
|---------------|---------------|------------------|---------------------|---------------|------------------|---------------|
| Employee      | EMP#&lt;id&gt;  | METADATA         | SLACK#&lt;slack_id&gt; | EMP#&lt;id&gt;  | MANAGER#&lt;mgr_id&gt; | EMP#&lt;id&gt;  |
| ReviewCycle   | CYCLE#&lt;id&gt; | METADATA         | -                   | -             | -                | -             |
| ManagerReview | CYCLE#&lt;id&gt; | REVIEW#&lt;emp_id&gt; | -                   | -             | EMP#&lt;emp_id&gt;   | CYCLE#&lt;id&gt;  |
| PeerRequest   | REQ#&lt;id&gt;   | METADATA         | -                   | -             | CYCLE#&lt;id&gt;      | REQ#&lt;id&gt;     |
| PeerFeedback  | CYCLE#&lt;id&gt; | PEER#&lt;emp_id&gt;#&lt;peer_id&gt; | - | -             | EMP#&lt;emp_id&gt;   | PEER#&lt;id&gt;     |
| UpwardFeedback| CYCLE#&lt;id&gt; | UPWARD#&lt;emp_id&gt; | -                | -             | EMP#&lt;emp_id&gt;   | UPWARD#&lt;id&gt;    |
| Document      | DOC#&lt;id&gt;   | METADATA         | -                   | -             | EMP#&lt;emp_id&gt;   | CYCLE#&lt;id&gt;  |
| AuditLog      | AUDIT#&lt;id&gt; | METADATA         | -                   | -             | -                | -             |

Employees: MANAGER#null for no manager (root). Direct reports: query GSI2 where GSI2PK = MANAGER#&lt;manager_id&gt;.
