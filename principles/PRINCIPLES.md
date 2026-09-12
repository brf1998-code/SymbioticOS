# Operating principles

These rules govern every module and every change built by agents or humans.

1. **Operator-first.** Every screen is designed for the person on the floor. One prominent action per role. Phone and tablet first. Nobody should need training to use a page.
2. **Never make operators navigate.** A role gets its own view showing exactly what that role needs. No menus of menus.
3. **The manager gate is structural.** Nothing reaches a live module without a human approval. Agents write to staging only.
4. **Plain language everywhere a human reads.** Proposals, requirements, diffs, and failures are written for a production manager, not a developer.
5. **Small changes, shipped fast.** Prefer the smallest change that removes the reported friction. If a request is really three changes, say so and split it.
6. **Adoption is the deliverable.** A feature that is not used does not ship again in the next revision. Feedback recurrence decides priority.
7. **Every action on the record.** Agent runs, deploys, rollbacks, and decisions are logged and visible.
8. **The tour stays true.** Every module carries a `tour.json` (title, intro, steps of `path`, `target`, `title`, `body`) that walks a new operator through its screens, ending at the feedback button. When a change renames, moves or removes something a tour step points at, update that step in the same change. Targets are CSS selectors on the module's own pages; keep them to stable ids.
