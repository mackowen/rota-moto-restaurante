# Browser regression: Bootstrap SMTP post-send failure

Chromium/CDP QA against `/bootstrap.html`. All calls to `/api/identity/bootstrap/smtp/test` were intercepted; the synthetic 503 represented SMTP acceptance followed by local audit failure. No SMTP connection or email occurred.

Result: PASS. Two mocked test requests were observed; the rapid duplicate click was suppressed, and the next request occurred only after accepting the explicit resend confirmation. The UI showed an accepted-send/local-audit message without raw response text. Six light/dark viewport combinations (390×844, 768×1024, 1440×900) had no horizontal overflow or JavaScript exceptions. External Continue stayed disabled without saved SMTP/invitation settings; local-only enabled it only after explicit selection.

- `report.json`: sanitized assertions and request counts.
- `smtp-*.png`: viewport captures of the synthetic form state.
