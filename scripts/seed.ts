/**
 * Demo data: one facilitator, six teachers, one PD session with three groups.
 * Safe to run twice. DEMO ACCOUNTS ONLY: change or delete them before real use.
 *   npx tsx scripts/seed.ts
 */
import { getDb } from "../lib/db";
import { createUser } from "../lib/auth";
import { addQuestion, createParticipants, createSession, sessionDetail } from "../lib/facilitator";
import type { User } from "../lib/types";

export const DEMO_PASSWORD = "demo-pass-123";
export const DEMO_JOIN_CODE = "DEMO42";

const db = getDb();
const existing = db.prepare("SELECT id, email, name, role, must_change_password FROM users WHERE email = ?").get("facilitator@example.org") as User | undefined;
if (existing) {
  console.log("Demo data already present. Facilitator: facilitator@example.org");
  process.exit(0);
}

const fac = createUser({ email: "facilitator@example.org", name: "Dana Facilitator", password: DEMO_PASSWORD, role: "facilitator" });
const { id } = createSession(fac, {
  title: "Fractions lesson study: Year 5 (demo)",
  description: "Watch the classroom clip, then note what you see before we dig deeper together.",
  video_title: "Year 5 fractions lesson, clip 2",
  video_url: "",
  num_groups: 3,
  salient_criteria:
    "Prefer points where groups noticed different things about the same moment; points about student reasoning rather than teacher behaviour; points that could shape next-step teaching.",
});
db.prepare("UPDATE pd_sessions SET join_code = ? WHERE id = ?").run(DEMO_JOIN_CODE, id);
for (const q of [
  "Where did students use representations (drawings, number lines, objects) and what did they reveal about their thinking?",
  "What did the teacher's questions invite students to explain?",
  "Which student ideas could be built on in the next lesson?",
]) addQuestion(fac, id, { text: q });

const detail = sessionDetail(fac, id);
const people = [
  ["Alex Teacher", "alex@example.org"],
  ["Bao Teacher", "bao@example.org"],
  ["Chen Teacher", "chen@example.org"],
  ["Dev Teacher", "dev@example.org"],
  ["Eli Teacher", "eli@example.org"],
  ["Fay Teacher", "fay@example.org"],
];
people.forEach(([name, email], i) => {
  const group = detail.groups[Math.floor(i / 2)];
  const res = createParticipants(fac, id, { people: [{ name, email }], group_id: group.id }).results[0];
  // demo accounts get a known password and no forced change
  db.prepare("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = 'facilitator@example.org'), must_change_password = 0 WHERE id = ?").run(res.user_id);
});
console.log(`Seeded. Facilitator facilitator@example.org / ${DEMO_PASSWORD}. Teachers alex|bao|chen|dev|eli|fay@example.org / ${DEMO_PASSWORD}. Join code ${DEMO_JOIN_CODE}.`);
