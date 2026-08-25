# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in this application, please report it
privately rather than opening a public GitHub issue. Email the maintainers (or your organization's
internal security contact) with:

- A description of the issue and its potential impact.
- Steps to reproduce, including any relevant request/response details (redact secrets).
- The version/commit you tested against.

Please do not test against production data or attempt to access another employee's real review
content, upward-feedback submissions, or People-only notes while investigating.

## Response

We aim to acknowledge reports within 3 business days and to provide an initial assessment within
10 business days. Timeline depends on severity and complexity; we'll keep you updated as we
investigate and remediate.

## Supported versions

Only the latest `main` branch is supported. There are no maintained release branches at this time.

## Scope

See `docs/SECURITY.md` for the technical security design (authentication, fail-closed startup
checks, the automation API's deliberately limited scope, logging redaction, HTTP hardening,
document privacy) and a short threat model covering the Primary Approver role, upward-feedback
re-identification risk, and insider-threat scenarios.
