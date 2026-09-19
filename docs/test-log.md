# Test log

One line per case. Format:

```
<case id> | <date> | PASS|FAIL|SKIP | <what happened> | blocker|pilot|polish | <where it was filed>
```

Severity: `blocker` stops a gate. `pilot` must be fixed before Pilot 1.
`polish` goes to the backlog.

See `TEST-CAMPAIGN.md` for the cases.

## Stage 0

S0-70 | 2026-09-17 | PASS | build model dropdown lists Fable 5.1 after the Agent SDK 0.3.274 upgrade | polish | n/a
S0-74 | 2026-09-18 | PASS | module gate unit cases, 73 of 73 in the cloud sandbox; scanner also read 2,040 files under node_modules with no false "unreadable" | pilot | n/a
S0-75 | 2026-09-18 | PASS | sandbox, fake agent: UI build that touched routes.js stopped before staging, card checked by screenshot (no Override, no preview link) | pilot | n/a
S0-76 | 2026-09-18 | PASS | sandbox: fix round logged "the platform put back: routes.js", passed the gate, reached the deploy gate, deployed | pilot | n/a
S0-77 | 2026-09-18 | PASS | sandbox: functionality build reading process.env stopped with file, line and quoted code; checks log reason "module gate" | pilot | n/a
S0-78 | 2026-09-18 | PASS | sandbox: override refused on a gate stop, run stayed failed | pilot | n/a
S0-79 | 2026-09-18 | PASS | sandbox: goto the refused draft refused (also the draft a retry left behind); goto v1 and forward to a once-live version both worked | pilot | n/a
S0-80 | 2026-09-18 | PASS | sandbox: new module build stopped before validateModule loaded it; fix round built, passed, went live | pilot | n/a
S0-81 | 2026-09-19 | PASS | sandbox: reviewer-failed cancelled draft marked NEVER APPROVED, goto refused, floor unchanged | pilot | n/a
S0-82 | 2026-09-19 | PASS | module gate unit cases 87 of 87 (adds page rules and header rules) | pilot | n/a
S3-06 | 2026-09-19 | PASS | headless browser: live and staged module pages, kpis charts and chat, the amber bar all clean under CSP; fetch of board, deploy API, admin API and a service worker all blocked by the browser | pilot | n/a
S3-07 | 2026-09-19 | PASS | sandbox two-company matrix, 60 checks: every cross-company path and id-addressed route refused; board answer carries no hash | pilot | n/a
S3-08 | 2026-09-19 | PASS | sandbox: setting a company's passwords signed its people out, left the other company signed in | pilot | n/a
S3-09 | 2026-09-19 | PASS | sandbox: acme at $5 of a $2 budget refused with a plain reason; demo unaffected; board showed acme's own budget | pilot | n/a
S3-10 | 2026-09-19 | PASS | sandbox: backup round trip identical incl. logins, intakes, attachment bytes, check labels; old-format backup fell back to shared passwords | pilot | n/a

## Stage 1

S1-07 | 2026-09-17 | PASS | one UI change built on Sonnet 5 (regression) and one on Fable 5.1 (first Fable build on the live instance), both completed and deployed by Brendan; agent-confirmed model in evidence.models_seen | polish | n/a

## Stage 2

## Stage 3

## Stage 4

## Stage 5

## Stage 6
