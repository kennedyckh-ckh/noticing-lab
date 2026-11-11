/**
 * Checks every AI output (model, simulated, or facilitator-edited) before it is stored.
 * It cannot prove the text is true, but it removes what can be checked mechanically:
 * unknown entry ids, uncited items, invented timestamps, mislabelled groups, one-sided "disagreements".
 */
import type { AiKind, CrossGroupContent, GroupSummaryContent, SalientContent } from "./types";
import { ts, type EntrySnap } from "./entries";

export const STANDING_CAVEAT = "Based only on what participants wrote. The AI did not watch the video, so it cannot confirm that anything described actually happened.";

interface Ctx {
  byId: Map<string, EntrySnap>;
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
function text(v: unknown, max = 1200): string {
  if (typeof v !== "string") return "";
  return v.replace(/\u0000/g, "").replace(/\s+\n/g, "\n").trim().slice(0, max);
}
function citedIds(v: unknown, c: Ctx): string[] {
  const out: string[] = [];
  for (const x of arr(v)) {
    if (typeof x !== "string") continue;
    const id = x.trim();
    if (c.byId.has(id)) {
      if (!out.includes(id)) out.push(id);
    } else if (id) {
      c.warnings.push(`Removed a citation to "${id.slice(0, 40)}", which is not an entry in this analysis.`);
    }
  }
  return out;
}
const groupsOf = (ids: string[], c: Ctx): string[] => [...new Set(ids.map((i) => c.byId.get(i)!.group_code))];

function dropped(name: string, n: number, c: Ctx, why: string) {
  if (n > 0) c.warnings.push(`Dropped ${n} ${name} item${n === 1 ? "" : "s"}: ${why}.`);
}

function caveats(v: unknown, extra: string[]): string[] {
  const own = arr(v).map((x) => text(x, 400)).filter(Boolean).slice(0, 8);
  return [STANDING_CAVEAT, ...extra, ...own.filter((x) => x !== STANDING_CAVEAT)];
}

function cleanGroupSummary(raw: Record<string, unknown>, c: Ctx, extra: string[]): GroupSummaryContent {
  let bad = 0;
  const observations = arr(raw.observations).flatMap((o) => {
    if (!isObj(o)) return [];
    const source_ids = citedIds(o.source_ids, c);
    const t = text(o.text);
    if (!t || source_ids.length === 0) return (bad++, []);
    let timestamp = text(o.timestamp, 12);
    if (timestamp && !source_ids.some((i) => ts(c.byId.get(i)!) === timestamp)) {
      c.warnings.push(`Removed timestamp "${timestamp}": none of the cited entries gives that time.`);
      timestamp = "";
    }
    return [{ text: t, source_ids, ...(timestamp ? { timestamp } : {}) }];
  });
  dropped("observation", bad, c, "no valid source entry");
  bad = 0;
  const interpretations = arr(raw.interpretations).flatMap((o) => {
    if (!isObj(o)) return [];
    const source_ids = citedIds(o.source_ids, c);
    const t = text(o.text);
    if (!t || source_ids.length === 0 || !source_ids.some((i) => c.byId.get(i)!.interpretation.trim())) return (bad++, []);
    return [{ text: t, source_ids }];
  });
  dropped("interpretation", bad, c, "no valid source entry that contains an interpretation");
  bad = 0;
  const disagreements = arr(raw.disagreements).flatMap((d) => {
    if (!isObj(d)) return [];
    const positions = arr(d.positions).flatMap((p) => {
      if (!isObj(p)) return [];
      const source_ids = citedIds(p.source_ids, c);
      const position = text(p.position);
      return position && source_ids.length ? [{ position, source_ids }] : [];
    });
    const topic = text(d.topic);
    if (!topic || positions.length < 2) return (bad++, []);
    return [{ topic, positions }];
  });
  dropped("disagreement", bad, c, "needs a topic and at least two cited positions");
  bad = 0;
  const open_questions = arr(raw.open_questions).flatMap((o) => {
    if (!isObj(o)) return [];
    const source_ids = citedIds(o.source_ids, c);
    const t = text(o.text);
    if (!t || source_ids.length === 0) return (bad++, []);
    return [{ text: t, source_ids }];
  });
  dropped("open question", bad, c, "no valid source entry");
  return { observations, interpretations, disagreements, open_questions, caveats: caveats(raw.caveats, extra) };
}

function cleanCrossGroup(raw: Record<string, unknown>, c: Ctx, extra: string[]): CrossGroupContent {
  let bad = 0;
  // group labels are recomputed from the cited entries, never trusted from the model
  const common_ground = arr(raw.common_ground).flatMap((o) => {
    if (!isObj(o)) return [];
    const source_ids = citedIds(o.source_ids, c);
    const groups = groupsOf(source_ids, c);
    const t = text(o.text);
    if (!t || groups.length < 2) return (bad++, []);
    return [{ text: t, groups, source_ids }];
  });
  dropped("common-ground", bad, c, "must cite entries from at least two groups");
  bad = 0;
  const differences = arr(raw.differences).flatMap((d) => {
    if (!isObj(d)) return [];
    const positions = arr(d.positions).flatMap((p) => {
      if (!isObj(p)) return [];
      const source_ids = citedIds(p.source_ids, c);
      const position = text(p.position);
      const g = groupsOf(source_ids, c);
      return position && g.length === 1 ? [{ group: g[0], position, source_ids }] : [];
    });
    const topic = text(d.topic);
    if (!topic || positions.length < 2) return (bad++, []);
    return [{ topic, positions }];
  });
  dropped("difference", bad, c, "needs a topic and at least two positions, each citing one group");
  bad = 0;
  const unique_noticings = arr(raw.unique_noticings).flatMap((o) => {
    if (!isObj(o)) return [];
    const source_ids = citedIds(o.source_ids, c);
    const g = groupsOf(source_ids, c);
    const t = text(o.text);
    if (!t || g.length !== 1) return (bad++, []);
    return [{ group: g[0], text: t, source_ids }];
  });
  dropped("single-group", bad, c, "must cite entries from exactly one group");
  return { common_ground, differences, unique_noticings, caveats: caveats(raw.caveats, extra) };
}

const BASES = ["observation", "interpretation", "disagreement", "question"] as const;

function cleanSalient(raw: Record<string, unknown>, c: Ctx, extra: string[]): SalientContent {
  let bad = 0;
  const points = arr(raw.points).flatMap((p) => {
    if (!isObj(p)) return [];
    const source_ids = citedIds(p.source_ids, c);
    const title = text(p.title, 200);
    const why = text(p.why_salient);
    const basis = BASES.find((b) => b === p.basis);
    if (!title || !why || !basis || source_ids.length === 0) return (bad++, []);
    return [
      {
        title,
        why_salient: why,
        criteria_matched: arr(p.criteria_matched).map((x) => text(x, 300)).filter(Boolean).slice(0, 5),
        basis,
        source_ids,
        discussion_prompt: text(p.discussion_prompt, 500),
      },
    ];
  }).slice(0, 8);
  dropped("discussion-point", bad, c, "missing text, basis or valid source entries");
  return { points, caveats: caveats(raw.caveats, extra) };
}

export function normaliseContent(kind: AiKind, raw: unknown, entries: EntrySnap[], extraCaveats: string[] = []): { content: Record<string, unknown>; warnings: string[]; sourceIds: string[] } {
  const c: Ctx = { byId: new Map(entries.map((e) => [e.id, e])), warnings: [] };
  const r = isObj(raw) ? raw : {};
  if (!isObj(raw)) c.warnings.push("The model did not return a JSON object; the result is empty.");
  const content =
    kind === "group_summary" ? cleanGroupSummary(r, c, extraCaveats) : kind === "cross_group" ? cleanCrossGroup(r, c, extraCaveats) : cleanSalient(r, c, extraCaveats);
  const note = text(r.facilitator_note, 2000);
  const out: Record<string, unknown> = { ...content, ...(note ? { facilitator_note: note } : {}) };
  const used = new Set<string>();
  JSON.stringify(out, (k, v) => {
    if (k === "source_ids" && Array.isArray(v)) v.forEach((x) => used.add(String(x)));
    return v;
  });
  return { content: out, warnings: [...new Set(c.warnings)], sourceIds: [...used].sort() };
}
