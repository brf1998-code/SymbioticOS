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
S0-97 | 2026-09-19 | PASS | sandbox, fresh database, 37 of 37 checks end to end against the stand-in SAP: setup saved with the login encrypted, test 5 rows with mapped sample, connected, module read mapped fresh rows, cached, on the record; the login absent from every answer and the backup | pilot | n/a
S0-98 | 2026-09-19 | PASS | sandbox: dead address with cache cleared gave a plain reason (refused the connection); with an old cache the old 5 rows came back fresh=false and the card stayed connected with the trouble shown | pilot | n/a
S0-99 | 2026-09-19 | PASS | sandbox: OnHandQty came back as an empty field with the other three fine; a path with {item} on a query with no params was refused with the param named; an OData filter written into the path reached the ERP (1 row for clip) | pilot | n/a
S0-100 | 2026-09-19 | PASS | sandbox: the note names the access, the lookup and its four fields, the source, the cache time, how the login is kept; no dashes | pilot | n/a
S3-12 | 2026-09-19 | PASS | gate unit: base_url and user in a module declaration refused with the key named; no fields refused; no queries refused; a proper declaration passes (also in the connections unit cases, 38 of 38) | pilot | n/a
S0-101 | 2026-09-19 | PASS | sandbox against the Epicor-shaped stand-in: user without key refused with "it wants an API key as well"; with both, 1230 of 1230 rows through a 100-row page cap; own $top left alone (25); BAQ parameter reached the ERP (1 row) | pilot | n/a
S0-102 | 2026-09-19 | PASS | sandbox: 11 columns published under plain names (job_num, part_description, qty_left, req_due_date as a date); renamed entries resolved "catalog" and the module's 1230 rows carried them; a path edit kept the catalog; publish before a test refused (24 of 24 checks in the catalog suite; connections unit 47 of 47) | pilot | n/a
S0-103 | 2026-09-19 | PASS | sandbox: ERP-FIELDS.md present from first mount, listed the published fields with types and the how-to, no plant values, no dashes; a fake-agent build's run log carried the ERP fields line | pilot | n/a
S0-105 | 2026-09-19 | PASS | sandbox with passwords on: manager's ERP view is label, status and managed=true, no address or column names anywhere in it; ERP test, IT note, setup, draft and data requests all 403 for the manager; ERP-FIELDS.md absent from the manager's agents page and present for the admin; printer settings still saved by the manager; checked in a headless browser too | pilot | n/a
S0-106 | 2026-09-19 | PASS | sandbox: missing field found by the platform, proposal waiting, board payload carried only plain words, approve and batch 409, admin request complete (Maria, the floor's words, lookup parts), loop health waiting_data 1 and waiting 0, on the record (28 of 28 checks in the data check suite) | pilot | n/a
S0-107 | 2026-09-19 | PASS | sandbox: publish proposed the item again on its own, status ok, old proposal superseded, request provided, approve 200 | pilot | n/a
S0-108 | 2026-09-19 | PASS | sandbox: dismiss without a sentence refused; with one, the card carried it, approve as is 409, approve with an edited body 200 | pilot | n/a
S0-109 | 2026-09-19 | PASS | sandbox: 20 minute old cache served 1230 rows at once with fresh=false; next read fresh=true; one cache row per lookup | pilot | n/a
S0-104 | 2026-09-19 | OPEN | fake mode only so far: the canned draft named SOS_parts and the BaqSvc path, stored on the card, on the record, counted as erp_draft; the live Fable draft is unread until the first real run | pilot | live check open |
S0-110 | 2026-09-19 | PASS | sandbox with passwords on: names tidied ("  Maria   G " became "Maria G"), made PIN four digits and shown once (gone after a reload in a headless browser), duplicate refused case aside, own 6 digit PIN accepted, no plain PIN in the table, floor device 403 on the page and on the list | pilot | n/a
S0-111 | 2026-09-19 | PASS | headless browser on the paperline station page under its policy: wrong PIN typed on the keyboard said so and cleared, the digits stayed out of the message box behind the pad, right PIN on the pad gave "Sending as", typed-name box hidden, no policy violation, no script error; the board card and the record carried the person's name and id whatever was typed | pilot | n/a
S0-112 | 2026-09-19 | PASS | sandbox: same person on two devices; after a new PIN the second device was nobody once the ten second cache had passed | pilot | n/a
S0-113 | 2026-09-19 | PASS | sandbox: fifth wrong try answered "locked for 5 minutes", the right PIN then answered 429 with the wait, the manager's list showed the lock, a new PIN cleared it | pilot | n/a
S0-114 | 2026-09-19 | PASS | headless browser, manager's session, module page: GET and POST /people, /people/<id>/pin and /people/<id>/active all blocked by the page policy; /who answered 200; the PIN still worked afterwards. The picker's routes were split from the manager's for this | pilot | n/a
S0-115 | 2026-09-19 | PASS | sandbox: decline recorded as Dana/manager; the other company's manager got 403 on /who and /people and 404 signing in with a foreign id; a carried person cookie was nobody; forged and altered cookies were nobody (32 of 32 in the people run, 27 of 27 in the browser, 21 unit cases) | pilot | n/a
S0-116 | 2026-09-19 | PASS | sandbox with passwords on: Maria's request read "on the board", then "the manager has a proposal", then "the manager is checking it", then live with one to check; Eli saw none of it; a device with nobody signed in got an empty list, not an error | pilot | n/a
S0-117 | 2026-09-19 | PASS | headless browser, two floor tablets open on the station while the manager deployed over the API: both reloaded on their own; Eli's said "New here: ... Maria G asked for this." across the width of a phone; Maria's showed the card with her words and what was built and no second banner; a third device that had never been there said nothing; no policy violation, no script error | pilot | n/a
S0-118 | 2026-09-19 | PASS | sandbox and browser: no words refused; with words the follow-up was filed under Maria for the same tool, page and screen with follow_up_of set; the original stayed done with not_quite on it; the board showed the amber follow-up line with the first words and "Maria G says: not quite. The follow-up is #2."; the record carried her words and the follow-up id | pilot | n/a
S0-119 | 2026-09-19 | OPEN | fake mode only: the fake proposer confirmed the follow-up context reached the prompt (and an ordinary request got none). What a live model does with it is unread until the first real follow-up (S1-09) | pilot | live check open |
S0-120 | 2026-09-19 | PASS | browser: Later folded the card into the pill beside the feedback button, it stayed a pill after a reload, a tap reopened it, the panel said "1 to check"; Fixed it landed from My requests and left "Actually, not quite"; sandbox: the change of mind was allowed once with before=fixed on the record, a second one 409 | pilot | n/a
S0-121 | 2026-09-19 | PASS | sandbox: someone else 403, nobody signed in 401, a nameless request answered by Eli and recorded as Eli; a rolled-back batch left the news, read "taken back off" in My requests and answered 409; another company 403 on requests, news and answer, 404 through its own path | pilot | n/a
S0-122 | 2026-09-19 | PASS | browser on /admin after one fixed and one not quite: tile "50% fixed it, says the floor, 1 fixed, 1 not quite, 0 not said yet", the Shipped cell said the same, the table fit its card, no script errors (42 of 42 end to end, 26 of 26 in the browser, 26 unit cases plus 7 in health) | pilot | n/a

## Stage 1

S1-07 | 2026-09-17 | PASS | one UI change built on Sonnet 5 (regression) and one on Fable 5.1 (first Fable build on the live instance), both completed and deployed by Brendan; agent-confirmed model in evidence.models_seen | polish | n/a

## Stage 2

## Stage 3

## Stage 4

## Stage 5

## Stage 6
