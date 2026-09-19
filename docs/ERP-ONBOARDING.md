# Bringing a plant's ERP online: the workflow

Written 2026-09-19. The ERP connection is the most engineer-heavy thing Anetix does for a plant, so this is the path that keeps our time on it small. It covers what is built (`src/connections.js`, the ERP kind), what a person still does, and the two tracks we expect first: Epicor Kinetic (a friendly site as the rehearsal, with their permission) and SAP (NEWP). Anything marked [CONFIRM] is a fact about a specific system we have not seen yet. Times are left as [MEASURE] until the rehearsal run gives real ones.

## The shape of it

Reads only, ever. A module never knows where the ERP is or how to log in. It declares the lookups it needs in module.json (a name, what it is looked up by, the fields it reads, one plain sentence). The platform holds the address, the login (encrypted) and, per lookup, the path to call. Every lookup is built WIDE in the ERP once, and the platform's field catalog publishes every column it returns under a plain name. After that, a change that needs one more field is an ordinary change through the loop: the agent sees the field in `ERP-FIELDS.md`, adds it to the module's declaration, and nobody at Anetix or in the plant's IT does anything.

So our time goes into a lookup exactly once: when it is first built. The work is to make that once short.

## The steps, and who does each

| # | Step | Who | Built? | Time |
|---|---|---|---|---|
| 0 | Find out which system, which version, where it runs, who can build queries in it, whether it can be reached from outside (the questions below) | Anetix, first call | checklist below | [MEASURE] |
| 1 | The module's design names its lookups (intake question 11 and round 2; the build writes them into module.json) | the agent, approved by the manager | yes | none of ours |
| 2 | "Download the note for IT": what read-only access, which lookups and fields, where calls come from, how the login is kept, what we need back | manager sends it | yes (templated) | [MEASURE] waiting on IT |
| 3 | "Draft what IT needs to build": the model writes each lookup's definition, wide on purpose, with what it was unsure of | admin, one click | yes | a model call |
| 4 | Someone with query-design rights in the ERP builds the lookups from the draft | the plant's IT or their ERP partner; us only on a system we were given design rights on | their side | [MEASURE] |
| 5 | Admin enters the base URL, the login, each lookup's path; presses Test | Anetix | yes | [MEASURE] |
| 6 | "Publish every column under a plain name"; tidy names, add a note where a column is not obvious; leave out cost, price and people's details | Anetix | yes | [MEASURE] |
| 7 | From here on: new fields from existing lookups need nobody. A new KIND of data (a new lookup) repeats 3 to 6 for that lookup only | the loop | yes | none of ours |

What the Test button tells you, so nobody debugs by hand: the login was refused (and whether the system wants an API key as well), the path does not exist, the answer was not JSON (usually a login page), the certificate is not trusted, how many rows came back after paging, which declared fields came back empty, how each declared field was resolved (mapped by hand, from the catalog, matched by the column's own name, not found), and a path that uses a parameter the lookup does not have.

## Is there an easier way than an API account plus hand-built queries?

Checked 2026-09-19. Short version: the read path should stay an API with a read-only account, because every alternative either needs more rights than IT should give a vendor or moves work onto IT forever. What can shrink is step 4, the building of the queries.

| Option | What it is | Verdict |
|---|---|---|
| The agent drafts, a person pastes (Epicor) | Kinetic 2024.2 and later: BAQ Designer can generate a BAQ from a SQL statement. Our draft writes that SQL. Known limits of the import: no CROSS APPLY, no OPENJSON. The BAQ still runs under normal BAQ security | **Use this.** Built as "Draft what IT needs to build". Needs their version to be 2024.2 or later [CONFIRM]; on older versions the same SQL is the spec a person builds the BAQ from |
| No BAQ at all (Epicor) | The REST API also serves the standard business objects as OData services (parts, jobs, orders) with `$select` and `$filter`. The platform's Epicor flavor can call those today: the path is free text | Good for a single-entity read with no joins, and needs nothing built in the ERP. Joins, calculated columns and stable paging are why BAQs stay the main road. Which services the API key's access scope allows is IT's call [CONFIRM] |
| The platform creates the BAQ itself over REST (Epicor) | Every Kinetic screen runs on REST services, BAQ Designer included, so creating a BAQ by API is plausible. We found no source confirming the calls | **Not for a customer's production ERP.** It needs query-design rights on our API key, far more than read-only, and one bad BAQ can hurt their server. Worth ten minutes on Wednesday: look for `Ice.BO.DynamicQuerySvc` in the REST help page and see what it offers [CONFIRM]. If it works, keep it for pilot or test environments where IT grants it on purpose |
| The platform creates the query itself (SAP Business One) | The Service Layer has a SQLQueries resource for saved queries that SAP documents as managed through the API | The closest thing to fully automatic, if NEWP runs Business One [CONFIRM]. Needs a new flavor (session login, not basic auth); not built |
| A key user builds a view (SAP S/4HANA Cloud) | Custom CDS Views app, then exposed as an external OData API through a custom communication scenario, a communication arrangement and a communication user | The normal road on S/4HANA Cloud public edition. No code, a key user can do it from our draft. We cannot do it for them |
| A developer builds a service (SAP S/4HANA on-prem or private, ECC) | An OData service through SAP Gateway, from a CDS view or a classic service; often reachable only inside their network [CONFIRM] | Slowest road: their SAP partner builds it. Released standard APIs may already cover jobs and stock; the draft is told to prefer them. If it is inside their network, the bridge transport is needed (designed, not built) |
| A scheduled file instead of an API | The ERP, or a script IT schedules, writes a CSV; it lands in the platform's spreadsheet connection | Useful where IT will not open any API and a nightly refresh is enough. Today the file is uploaded by hand on the connections page; an unattended push (a token on the upload) is not built [DECIDE] |
| Reading their database directly | A SQL login on the ERP's database | No. Cloud ERPs do not offer it, on-prem IT should refuse it, and it bypasses the ERP's own security |

## How to ask for a wide lookup (the rules the draft follows)

Few and wide. One lookup per thing the floor thinks in: jobs and their operations, parts and stock, orders and shipments. Inside each:

- The stable keys, always: company, the document number and its line, release or sequence numbers, the part number. Later modules join on these.
- Descriptions, quantities, dates, statuses, and a last-changed stamp (so a later module can read only what changed).
- A parameter for everything it is looked up by (job, part, a date window), a sort so paging is stable, and a row limit or window when the list can be long.
- Read only. In Epicor the BAQ is not updatable.
- Left out unless a module needs it: cost, price, margin, customer contact details, anything about employees beyond an id. Whatever the lookup returns is visible to the build agent by name once published.
- Named `SOS_<something>` so IT can find, audit and remove what is ours.

## Track A: Epicor Kinetic (the rehearsal site first)

What the platform expects: flavor "Epicor Kinetic"; base URL `https://<server>/<instance>/api/v2/odata/<Company>/`; a lookup's path `BaqSvc/<BAQ id>/Data?<Param>={param}`; login = the user, its password AND an API key (REST v2 wants a key for the access scope plus a user identity). The platform pages with `$top` and `$skip` until the rows stop, so a server that gives 100 rows at a time still returns the whole list (capped at 5000 rows per lookup; use a parameter or a window for more).

Wednesday's questions:

1. Which Kinetic version? (2024.2 or later means the SQL import exists.)
2. Cloud or on-prem, and can the REST address be reached from outside? If not, that is the bridge conversation, a useful one to have before NEWP.
3. Is REST v2 on, and will they make an API key whose access scope is only our BAQs (and any business object services we ask for)?
4. The read-only user: does the old one still exist, and what can it see?
5. Who builds BAQs there, and may I build ours myself on their system? If yes, in which environment (pilot or live)?
6. In the REST help page, what does `Ice.BO.DynamicQuerySvc` offer? (Ten minutes, only to learn whether automatic creation is real.)

Then the run, timing each step: draft, build the BAQs (paste the SQL if the version allows), enter base URL, login and paths, Test, publish the catalog, change a module to read one more published field and watch it need nobody.

Ground rules for this rehearsal: written permission that names read-only testing of Anetix's product against their system; its own company on the instance, never demo and never the showroom; BAQ names, paths, field maps and the login live in the platform's database, not in the repo, so the repo stays clean-room; nothing from the run goes in a deck without their sign-off.

## Track B: SAP (NEWP)

"SAP" is four different products for this purpose, so the first question decides everything else:

| If they run | The lookup is | Who builds it | Reach | Platform |
|---|---|---|---|---|
| S/4HANA Cloud, public edition | a released standard OData API, or a custom CDS view exposed as an external API | their key user, from our draft | from outside, with a communication user | the SAP flavor as built (basic auth, OData v2 or v4, next-page links) |
| S/4HANA private cloud or on-prem | a standard API or a custom OData service on SAP Gateway | their SAP partner or ABAP developer | often inside their network only [CONFIRM] | the SAP flavor; the bridge if it cannot be reached |
| ECC | a custom OData service on Gateway, if they have Gateway at all [CONFIRM] | their SAP partner | inside their network | the bridge, or the scheduled file |
| Business One | the Service Layer: entities with OData options, and saved SQL queries | possibly the platform itself through the API [CONFIRM], else their partner | depends on hosting | a new flavor (session login), not built |

NEWP's first questions: which SAP product and version, who hosts it, who their SAP partner is, whether anything is reachable from outside, who can create a read-only communication or technical user, and how long their change process takes for a new read-only service.

## What is built, and what is not

Built: the ERP kind with SAP, Epicor and plain JSON flavors; paging; the encrypted login; the Test button; the field catalog with automatic plain names and loose matching; `ERP-FIELDS.md` for the agents; the run-log line that says whether a build's ERP fields are available; the templated IT note; the model-written lookup drafts; two stand-in ERPs on the instance for the showroom and for tests (`/erp-demo/parts`, SAP shaped, and `/erp-demo/epicor/BaqSvc/SOS_Jobs/Data`, Epicor shaped with 1230 rows, a 100-row page cap and both credentials required).

Not built, in the order I would build them once a real system says which is needed: the bridge transport (a small program inside the plant's network that polls the platform for lookups, runs them, posts the rows; the same pattern as the label print helper); the Business One flavor; an unattended file push into the spreadsheet connection; automatic creation of BAQs over REST (only if Wednesday shows it is real, and only for environments where IT grants it on purpose).

## Sources

- Epicor Kinetic REST API v2 (URL shape, API key plus user, OData options, paging): https://knowledgelib.io/business/erp-integration/epicor-rest-api-v2/2026
- BAQ and BaqSvc REST limits, Epicor User Help Forum: https://www.epiusers.help/t/baq-ui-baqsvc-rest-api-limitations/107024
- REST pagination with $top and $skip, Epicor User Help Forum: https://www.epiusers.help/t/11-2-rest-api-pagination/101272
- SQL to BAQ in Kinetic 2024.2, Epicor User Help Forum: https://www.epiusers.help/t/sql-to-baq/119680
- What the SQL import cannot represent (CROSS APPLY, OPENJSON), Epicor User Help Forum: https://www.epiusers.help/t/help-with-converting-a-sql-query-to-a-baq/136809
- SQL to BAQ conversion overview: https://www.jpgal.co.uk/understanding-the-significance-of-sql-to-baq-conversion/
- Exposing a custom CDS view as an external API, SAP Help Portal: https://help.sap.com/docs/SAP_S4HANA_CLOUD/0f69f8fb28ac4bf48d2b57b9637e81fa/ed003551d9c8456b914f7c94bd311b8a.html
- Custom CDS views in S/4HANA public cloud, tutorial: https://sapzero2hero.com/2025/04/16/tutorial-custom-cds-view-in-s-4hana-public-cloud/
- SAP Business One Service Layer (login, paging, OData options): https://www.apideck.com/blog/sap-business-one-api-integration-guide
- SAP Business One Service Layer SQL queries, SAP Community: https://community.sap.com/t5/enterprise-resource-planning-blog-posts-by-sap/new-sap-business-one-service-layer-sql-query/ba-p/13462991
