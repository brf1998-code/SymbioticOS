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
S0-83 | 2026-09-19 | PASS | sandbox, fake agent: one feedback item read as a thread on the record (filed, drafted, edited with both texts, approved with run); run rows carried requirement before/after, build, verdict, summary, deploy | pilot | n/a
S0-84 | 2026-09-19 | PASS | sandbox: decline reason, close, run_fixed with findings, cancel, version switch, doc before/after all on the record; unchanged doc save wrote nothing; chat question and answer, intake answers with their questions, Fable rounds, design, adjustment, confirm all present (34 of 34 checks) | pilot | n/a
S0-85 | 2026-09-19 | PASS | sandbox: UPDATE and DELETE on platform.record refused by the trigger; deleting acme removed acme's rows only | pilot | n/a
S0-86 | 2026-09-19 | PASS | sandbox: export downloaded as an attachment with the company's rows; backup carried the record table | pilot | n/a
S0-87 | 2026-09-19 | PASS | headless browser at 1280x800: band 70px (9% of the screen), columns start at 205px; at 390x844 the band is 225px, chips wrap, no sideways scroll, no console errors | pilot | n/a
S0-88 | 2026-09-19 | PASS | loop health unit cases 37 of 37 | pilot | n/a
S0-89 | 2026-09-19 | PASS | sandbox, fake agent, fresh database: 19 of 19 checks on the health answer after the driven loops; a run at the deploy gate showed as waiting first; acme kept its own row and the fleet added up | pilot | n/a
S0-90 | 2026-09-19 | PASS | headless browser at 1280: 9 fleet tiles, 4 table rows (demo, acme, fleet, header), table 1174px in a 1174px card, window switch to 7 days reloaded, no script errors (the one console line is the missing favicon) | pilot | n/a
S0-91 | 2026-09-19 | PASS | connections unit cases 25 of 25 | pilot | n/a
S0-92 | 2026-09-19 | PASS | sandbox, fresh database, 44 of 44 checks end to end: preview by name and alias, blockers (bad number with the row named, missing key column, a photo), load of 4 rows replaced 3 and added 1 and left the rest, connected with file and count, on the record, parsed rows dropped after the load | pilot | n/a
S0-93 | 2026-09-19 | PASS | headless browser with a simulated Browser Print on localhost:9100: station 1 printed a traveler, the picker listed ZT411 once, the ZPL reached the write endpoint with the barcode, toast named the printer, job done on ZT411, second label printed without asking; connections page showed connected, printers seen, labels go to ZT411; test label printed from the page; no script errors (15 of 15) | pilot | n/a
S0-94 | 2026-09-19 | PASS | same, a browser context where localhost:9100 refuses: toast said Browser Print is not running on this device with what to do, the job failed with that reason | pilot | n/a
S0-95 | 2026-09-19 | PASS | sandbox: settings saved and bounded (dpmm 99 fell back to 8); the preview endpoint answered 503 with the ZPL because the sandbox cannot reach the renderer (a live check on Railway is still to do) | pilot | live check open |
S0-96 | 2026-09-19 | PASS | sandbox: device B saw nothing of device A's job and could not finish it; a test label from device B went to B | pilot | n/a
S3-11 | 2026-09-19 | PASS | gate unit: erp kind refused, files without key refused, printer without labels/tag.zpl refused, all three pass once complete; station page policy carries localhost:9100 and /api/c/demo/print/ and not the board; the kpis page policy carries neither | pilot | n/a

## Stage 1

S1-07 | 2026-09-17 | PASS | one UI change built on Sonnet 5 (regression) and one on Fable 5.1 (first Fable build on the live instance), both completed and deployed by Brendan; agent-confirmed model in evidence.models_seen | polish | n/a

## Stage 2

## Stage 3

## Stage 4

## Stage 5

## Stage 6
