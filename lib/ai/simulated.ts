/**
 * SIMULATION, not AI. A rule-based stand-in used when no API key is configured, so the whole
 * review -> edit -> publish workflow can be tried. It restates participants' own words entry by
 * entry and flags possible disagreements by timestamp proximity and keyword overlap. It does not
 * understand meaning and says so in its caveats. Output goes through the same validator as real output.
 */
import type { AiKind } from "./types";
import { ts, type EntrySnap } from "./entries";

const NOTE = "SIMULATED OUTPUT: no AI model was used. This restates what participants wrote and flags possible overlaps by timestamp and shared words only. It does not understand the entries.";
const STOP = new Set("about after again also because before being could every from have into just more most other over really should since some than that their them then there these they this those through very were what when where which while with would your".split(" "));

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const words = (s: string): string[] => [...new Set(s.toLowerCase().match(/[a-z]{5,}/g) ?? [])].filter((w) => !STOP.has(w));
const entryWords = (e: EntrySnap) => new Set(words(`${e.observation} ${e.interpretation}`));

/** Two entries by different contributors about (about) the same moment, with different interpretations. */
function samePlace(a: EntrySnap, b: EntrySnap, crossGroup: boolean): boolean {
  if (a.id === b.id || (!crossGroup && a.contributor === b.contributor) || (crossGroup && a.group_code === b.group_code)) return false;
  if (!a.interpretation.trim() || !b.interpretation.trim()) return false;
  if (a.interpretation.trim().toLowerCase() === b.interpretation.trim().toLowerCase()) return false;
  if (a.timestamp_sec !== null && b.timestamp_sec !== null) return Math.abs(a.timestamp_sec - b.timestamp_sec) <= 20;
  return !!a.responding_to && a.responding_to === b.responding_to;
}

function pairs(entries: EntrySnap[], crossGroup: boolean): Array<[EntrySnap, EntrySnap]> {
  const out: Array<[EntrySnap, EntrySnap]> = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) if (samePlace(entries[i], entries[j], crossGroup)) out.push([entries[i], entries[j]]);
  return out;
}

function groupSummary(entries: EntrySnap[]) {
  return {
    observations: entries.map((e) => ({
      text: trunc(e.observation + (e.evidence ? ` (evidence given: ${e.evidence})` : ""), 600),
      source_ids: [e.id],
      timestamp: ts(e),
    })),
    interpretations: entries.filter((e) => e.interpretation.trim()).map((e) => ({ text: trunc(e.interpretation, 500), source_ids: [e.id] })),
    disagreements: pairs(entries, false)
      .slice(0, 5)
      .map(([a, b]) => ({
        topic: `Entries ${a.id} and ${b.id} are about the same moment${ts(a) ? ` (around ${ts(a)})` : ""} but give different interpretations. Check whether they conflict.`,
        positions: [
          { position: trunc(a.interpretation, 400), source_ids: [a.id] },
          { position: trunc(b.interpretation, 400), source_ids: [b.id] },
        ],
      })),
    open_questions: entries.filter((e) => e.question.trim()).map((e) => ({ text: trunc(e.question, 400), source_ids: [e.id] })),
    caveats: [NOTE],
  };
}

function crossGroup(entries: EntrySnap[]) {
  const byWord = new Map<string, Map<string, EntrySnap>>(); // word -> group -> first entry
  for (const e of entries) {
    for (const w of entryWords(e)) {
      if (!byWord.has(w)) byWord.set(w, new Map());
      if (!byWord.get(w)!.has(e.group_code)) byWord.get(w)!.set(e.group_code, e);
    }
  }
  const shared = [...byWord.entries()].filter(([, g]) => g.size >= 2).sort((a, b) => b[1].size - a[1].size).slice(0, 5);
  const wordsByGroup = new Map<string, Set<string>>();
  for (const e of entries) wordsByGroup.set(e.group_code, new Set([...(wordsByGroup.get(e.group_code) ?? []), ...entryWords(e)]));
  const unique: Array<{ group: string; text: string; source_ids: string[] }> = [];
  for (const code of wordsByGroup.keys()) {
    const others = new Set([...wordsByGroup.entries()].filter(([k]) => k !== code).flatMap(([, s]) => [...s]));
    const best = entries
      .filter((e) => e.group_code === code)
      .map((e) => ({ e, n: [...entryWords(e)].filter((w) => !others.has(w)).length }))
      .sort((a, b) => b.n - a.n)[0];
    if (best && best.n >= 2) unique.push({ group: code, text: trunc(best.e.observation, 400), source_ids: [best.e.id] });
  }
  return {
    common_ground: shared.map(([w, g]) => ({
      text: `Entries from ${[...g.keys()].join(" and ")} all mention "${w}".`,
      groups: [...g.keys()],
      source_ids: [...g.values()].map((e) => e.id),
    })),
    differences: pairs(entries, true)
      .slice(0, 5)
      .map(([a, b]) => ({
        topic: `Entries from different groups about the same moment${ts(a) ? ` (around ${ts(a)})` : ""} give different interpretations.`,
        positions: [
          { group: a.group_code, position: trunc(a.interpretation, 400), source_ids: [a.id] },
          { group: b.group_code, position: trunc(b.interpretation, 400), source_ids: [b.id] },
        ],
      })),
    unique_noticings: unique,
    caveats: [NOTE],
  };
}

function salient(entries: EntrySnap[], criteria: string) {
  const critSentences = criteria.split(/[.;\n]+/).map((s) => s.trim()).filter(Boolean);
  const critWords = new Set(words(criteria));
  const inPair = new Map<string, EntrySnap>();
  for (const [a, b] of pairs(entries, true)) {
    inPair.set(a.id, b);
    inPair.set(b.id, a);
  }
  const scored = entries
    .map((e) => {
      const matched = [...entryWords(e)].filter((w) => critWords.has(w));
      const score = matched.length * 2 + (inPair.has(e.id) ? 3 : 0) + (e.question.trim() ? 1 : 0);
      return { e, matched, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return {
    points: scored.map(({ e, matched, score }) => {
      void score;
      const partner = inPair.get(e.id);
      const reasons = [
        matched.length ? `Shares words with your criteria (${matched.slice(0, 4).join(", ")}).` : "",
        partner ? `${partner.group_code} gives a different interpretation of the same moment.` : "",
        e.question.trim() ? "The entry raises a question." : "",
      ].filter(Boolean);
      return {
        title: trunc(e.observation.split(/\s+/).slice(0, 9).join(" "), 80),
        why_salient: reasons.join(" "),
        criteria_matched: critSentences.filter((s) => matched.some((w) => s.toLowerCase().includes(w))).slice(0, 3),
        basis: partner ? "disagreement" : e.question.trim() ? "question" : "observation",
        source_ids: partner ? [e.id, partner.id] : [e.id],
        discussion_prompt: partner ? "What in the video supports each of these readings?" : e.question.trim() ? "What would you look for in the video to answer this question?" : "What else in the video relates to this observation?",
      };
    }),
    caveats: [NOTE, ...(scored.length === 0 ? ["No entry matched the criteria by shared words or by cross-group differences."] : [])],
  };
}

export function simulate(kind: AiKind, entries: EntrySnap[], criteria: string): unknown {
  if (kind === "group_summary") return groupSummary(entries);
  if (kind === "cross_group") return crossGroup(entries);
  return salient(entries, criteria);
}
