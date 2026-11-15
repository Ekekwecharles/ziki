
## 2026-11-12 — Fix on Ziki for paid security checks (#897)

- Started from the shared security-check models and the existing private finding conversion. The paid report has no remediation picker in Part 5 yet.
- Added a named picker, authenticated project lookup and an atomic submission. It locks the check, verifies the requester, payment, project and result IDs, and reuses linked findings on repeat requests.
- The existing converter creates a vetted issue with placeholder text. The result text is copied inside PostgreSQL into the private finding. The report page hookup belongs to Part 4.
- Full lint and type check passed. The full unit suite timed out after a Windows fork worker stopped responding. The focused run passed 60 tests across the picker, private finding workflow, vetted conversion and security engine. The repository recheck passed lint, typecheck and 36 tests across the two edited test files.
- Outcome: Part 5 is ready for PR review. An integrated report-page and PostgreSQL run remains outstanding because Part 4 is separate and the local Docker daemon is unavailable.

- PR #647 review: merged main at 321a15ea after #643 and #648. Fixed the version conflict at 0.1.121 and gated the picker lookup and locked submission on the shared posted-report check. Added regressions for paid, unposted checks.
- The version gate, Prisma generation, focused lint, full type check and all 38 affected tests passed. Ready to rerun GitHub CI on PR #647.

## 2026-11-12 — N1 per-finding unlock follow-up (#897)

- The existing #647 implementation is on main alongside Dave's #643 and Hamzat's H0 (#651). Fast-forwarded the existing branch to cad84e5f.
- Replaced check-wide payment with the shared posted-report and per-result unlock checks. Kept the existing transaction, private finding links and named picker. The shared converter now records that the client selected an unlocked finding.
- Seyi's report already mounts the picker. Its per-finding update should pass only unlocked results from posted reports.
- Fast-forwarded to fe40886f after the free-scan PR merged and bumped the package from 0.1.125 to 0.1.126.
- Verification: the version gate, diff check, and full recheck passed. Lint reported 28 warnings and no errors, typecheck passed, and all 1,809 unit tests passed. The focused run passed all 45 tests.
- Outcome: N1 is verified locally and ready for PR review. The repeat submission tests use mocked database calls. The report page integration is part of Seyi's follow-up.

## 2026-11-13 — Sync N1 with the report integration (#908)

- Merged main after Seyi's #659 and raised the package version from 0.1.137 to 0.1.138. Confirmed the report page passes only unlocked findings to the picker after posting.
- The version check, lint and all 1,894 unit tests passed. The first typecheck hit a local Node memory limit while running alongside lint. Retrying typecheck separately and verifying the final PR head in GitHub CI.

## 2026-11-14 — Rename the finding picker

- Updated the picker heading and submit button to Move to your app. The report still reads the existing result-to-finding-to-issue link. The new report pill is owned by Seyi.

## 2026-11-14 — Standalone move page

- Added the standalone picker with server-priced simulated payment and the existing transactional issue link. The report integration remains a separate change.

- Refreshed the move picker using the Security payment page's severity badges, rounded cards, and blue action button. Grouped project selection and total in the same card.

- Merged upstream main with Seyi's #723, wired its report button to the standalone route, and raised the version to 0.1.176.

- Browser verification on the migrated local demo: opened Seyi's report, followed Move to your app, moved a sample result, and verified the reopened report links to the same Issue #245.

## 2026-11-15 — PR #730 review

- Shared the simulated payment write between unlock and move. The move still writes the linked issue in the same transaction. Moved the page loader into server-only code and added tests for requester scope and mixed prices. Renamed the button to Pay and move.
