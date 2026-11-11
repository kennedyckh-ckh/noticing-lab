# Noticing Lab: video-based teacher professional development

Participant teachers and facilitators work through two stages of noticing about a classroom video.
This is a working application with a real backend (own sign-in, SQLite database, server-side permission checks).

## Run it

```bash
npm install
npm run seed                                   # demo data (skip for an empty database)
NODE_ENV=production NEXT_PUBLIC_SHOW_DEMO=1 npm run build
NODE_ENV=production npm run start -- --port 3000
```

Demo logins (password `demo-pass-123`): `facilitator@example.org`; teachers `alex@`, `bao@` (Group 1), `chen@`, `dev@` (Group 2), `eli@`, `fay@` (Group 3) at `example.org`. Join code `DEMO42`.
Demo accounts are for trying the app only. For real use skip `npm run seed`, and create a facilitator with
`npm run create-facilitator -- you@school.org "Your Name" 'a-long-password'`.

Tests: `npm test` (84 tests, no server needed). Live check against a running server on fresh demo data: `npm run e2e`.
Note: set `NODE_ENV=production` for `build`/`start` (a different NODE_ENV breaks the Next.js build).

## How it works

| | |
|---|---|
| Sign-in | Email + password (scrypt-hashed). Server-side sessions, HttpOnly SameSite cookie, login throttling, CSRF origin check. Facilitators are created by the operator; facilitators create teacher accounts (temporary password, forced change at first sign-in). |
| Joining | A teacher enters the session join code **and** must be on a group roster set by the facilitator. They can only pick groups they are authorised for. |
| Part 1 | Each teacher writes their **own** entries (observation, optional timestamp, evidence, interpretation, optional question). Contributor is recorded. Teammates can read each other's entries but cannot edit them, so there is no shared text box to overwrite. Any member submits for the whole group; this locks Part 1 and stores an immutable snapshot. |
| Part 2 | Locked on the server until the facilitator unlocks it. Guiding questions are not even sent to browsers before that. Part 2 entries are separate rows from Part 1 and cannot change it. A group must have submitted Part 1 before adding Part 2 entries. |
| Facilitator | Draft / submitted status for both parts per group, read access to all contributions (including drafts), unlock Part 2, share selected submitted entries (contributor name hidden unless chosen), "x of y active groups submitted" with a typed, reasoned, logged override for missing groups, JSON/CSV export. |
| AI | Per-group summaries, cross-group comparison, salient discussion points from the facilitator's own criteria. Drafts are private; the facilitator edits, marks each as reviewed, and publishes with two separate buttons (group summaries / salient points). The cross-group comparison is facilitator-only by design. |

## What is simulated or not connected

* **AI is a simulator unless you set `ANTHROPIC_API_KEY`.** The simulator is rule-based (it restates entries and flags possible disagreements by timestamp proximity and shared words). It does not understand text. Everything it produces is labelled "Simulated" to the facilitator and to participants. The real-model path (official Anthropic SDK, default model `claude-opus-5-5`, structured JSON output) is implemented and tested **only with a fake client**; it has **not been run against the live API**.
* **No video player.** Sessions hold a video title and link that opens in a new tab. Timestamps are typed in by teachers.
* **No email.** Temporary passwords are shown once to the facilitator, who passes them on. No password-reset email; a facilitator must create a new account or the operator must reset it.
* **No single sign-on**, no co-facilitators (one session = one owning facilitator), no "reopen a submitted group" action.
* Login throttling is in memory (resets when the server restarts) and assumes one server process. SQLite is fine for a classroom-sized deployment, not for many servers.
* Data is not encrypted at rest beyond the disk itself. Exports contain names and emails.

## AI safeguards (what they do and do not guarantee)

* The AI reads only the immutable snapshots of **submitted** work, with contributors reduced to labels (C1, C2). No names or emails are sent.
* Participant text is placed only inside one JSON data block (angle brackets escaped) and the system prompt tells the model to treat it as data and ignore instructions in it. This is a **mitigation, not a guarantee**: a model can still be influenced by text.
* Every output is validated before saving, whether it came from the model, the simulator, or a facilitator edit: unknown entry ids are removed, items without a valid source are dropped, timestamps not present in a cited entry are removed, interpretation items must cite an entry that has an interpretation, group labels are recomputed from the cited entries, a "disagreement" needs two cited positions.
* The validator cannot prove a statement is true. The facilitator must read each draft against the entries before marking it reviewed.

## Security model, enforced in `lib/authz.ts` and `lib/router.ts`

Every route declares the role it needs and the router enforces authentication, role, forced password change and CSRF before the handler runs. Handlers then check session membership, group membership **and** current authorisation, stage release (Part 2) and ownership. Resources a user has no relationship to answer 404. A test walks every route anonymously and with the wrong role.
