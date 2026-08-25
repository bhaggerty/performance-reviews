# The Primary Approver

## What it is

Exactly one identity, configured (not hard-coded, not stored in the database) via the
`PRIMARY_APPROVER_EMAIL` environment variable / secret. `src/domain/authz.ts#computeRoles`:

```ts
const isPeopleAdmin = employee.is_people_admin || config.people.peopleAdminEmails.has(email);
const isPrimaryApprover = Boolean(
  config.people.primaryApproverEmail && email === config.people.primaryApproverEmail && isPeopleAdmin
);
```

Two things must both be true for someone to act as Primary Approver on a given request:

1. Their authenticated email (normalized, lowercased) matches `PRIMARY_APPROVER_EMAIL` exactly.
2. Their `Employee.is_people_admin` is `true`, **or** their email is in `PEOPLE_ADMIN_EMAILS`.

There is no `is_primary_approver` column, flag, or cached value anywhere in DynamoDB. Every check
(`requirePrimaryApprover`, and everything that calls it — see `docs/PERMISSIONS.md`) re-derives
this from scratch against the current config and the current `Employee` record on every request.

## Why no DB flag

A stored flag would create two ways to become Primary Approver — the config value, and whatever
wrote the flag — and the console would need a feature to manage that flag, which is exactly the
"an administrator can silently grant themselves approval rights" hole the assignment prohibits.
Making it purely config-derived means the _only_ way to change who holds the role is a deploy-time
configuration change, which is auditable through the deployment platform itself (see below).

## Fail-closed startup behavior

`src/config.ts` refuses to start in production without `PRIMARY_APPROVER_EMAIL` set:

```ts
if (isProduction) {
  required('PRIMARY_APPROVER_EMAIL', env.PRIMARY_APPROVER_EMAIL);
}
```

and `requirePrimaryApprover` itself throws `no_primary_approver_configured` if the value is ever
empty at check time — there is no fallback that grants approval rights to "every People admin"
when the config is missing. In non-production, the app will start without it (so local dev doesn't
require the full production configuration), but nothing can pass a Primary-Approver check either.

## Changing the Primary Approver safely

This is a **deploy-time configuration change**, not an in-app action:

1. Confirm the new approver's `Employee` record already has `is_people_admin: true`. If it
   doesn't, set that first (via a directory import row, or a future console admin-management
   feature — see `docs/GO_LIVE_CHECKLIST.md`). **This ordering matters**: pointing
   `PRIMARY_APPROVER_EMAIL` at someone who isn't a People admin yet silently leaves the role
   unheld — `isPrimaryApprover` stays `false` for them until both conditions are true, and no
   error surfaces to tell you why approval buttons are still disabled for that person.
2. Update `PRIMARY_APPROVER_EMAIL` through Union Station's runtime configuration/secret mechanism
   for this service (see `docs/UNION_STATION_DEPLOYMENT.md`).
3. Redeploy (or restart the task, per however Union Station applies config changes) so the new
   value is read at process startup.
4. Verify: have the new approver sign into the console and confirm the At Risk queue / Review
   Detail approve-and-release buttons are enabled for them.

## Break-glass

There is no in-app emergency-override path, by design — that would be exactly the kind of
approval-rights escalation the role is built to prevent. An emergency change to
`PRIMARY_APPROVER_EMAIL` requires whoever holds Union Station deployment access for this service.
Because the app itself never records who changed the config, **that change must be captured in the
deployment platform's own audit trail** (Union Station's deploy/config history) — this repository
cannot and does not log configuration changes made outside of it. Document your organization's
specific break-glass approval process (who signs off on an emergency Primary Approver change)
outside this repo, since it's a process control, not a code control.
