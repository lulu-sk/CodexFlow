# Security Policy

Thank you for helping keep CodexFlow and its users safe.

## Supported Versions

We aim to support the current `main` branch and the latest released version. Older versions may not receive security fixes.

## Reporting a Vulnerability

- Please do not open public Issues for security reports.
- Preferred: use GitHub Security Advisories (the "Report a vulnerability" button in the repository Security tab) to privately disclose details.
- If advisories are not available for you, open a minimal placeholder Issue asking a maintainer to initiate a private security channel, without sharing sensitive details publicly.

We usually respond within 3–5 days. After triage, we will work with you to reproduce, assess severity, and coordinate disclosure and a fix.

## Hardening Basics We Enforce

- Electron renderer security: `contextIsolation: true`, `nodeIntegration: false`, minimal `preload` surface audited.
- IPC input validation and least-privilege design, avoiding arbitrary FS access and command injection.
- DCO sign-off required on all patches so provenance is clear.

Thank you for your responsible disclosure and for improving CodexFlow security.

