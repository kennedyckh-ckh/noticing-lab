"use client";
import { useState } from "react";
import { Button, Label, inputClass } from "@/components/ui";
import { SourceChips } from "@/components/AiContentView";
import type { AiKind } from "@/lib/ai/types";

interface Field {
  k: string;
  label: string;
  rows?: number;
  readOnly?: boolean;
}
interface Section {
  key: string;
  title: string;
  fields: Field[];
  nested?: { key: string; title: string; fields: Field[] };
}

const SECTIONS: Record<AiKind, Section[]> = {
  group_summary: [
    { key: "observations", title: "What the group observed", fields: [{ k: "text", label: "Observation" }] },
    { key: "interpretations", title: "How the group interpreted it", fields: [{ k: "text", label: "Interpretation" }] },
    { key: "disagreements", title: "Where members see it differently", fields: [{ k: "topic", label: "Topic", rows: 2 }], nested: { key: "positions", title: "Position", fields: [{ k: "position", label: "Position", rows: 2 }] } },
    { key: "open_questions", title: "Open questions", fields: [{ k: "text", label: "Question", rows: 2 }] },
  ],
  cross_group: [
    { key: "common_ground", title: "Common ground", fields: [{ k: "text", label: "Point" }] },
    { key: "differences", title: "Differences between groups", fields: [{ k: "topic", label: "Topic", rows: 2 }], nested: { key: "positions", title: "Position", fields: [{ k: "position", label: "Position", rows: 2 }] } },
    { key: "unique_noticings", title: "Noticed by one group only", fields: [{ k: "text", label: "Point" }] },
  ],
  salient_points: [
    { key: "points", title: "Discussion points", fields: [{ k: "title", label: "Title", rows: 1 }, { k: "why_salient", label: "Why it is worth discussing", rows: 3 }, { k: "discussion_prompt", label: "Discussion prompt", rows: 2 }] },
  ],
};

type Obj = Record<string, unknown>;
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

export function AiEditor({ kind, initial, saving, error, onSave, onCancel }: { kind: AiKind; initial: unknown; saving: boolean; error: string | null; onSave: (content: unknown) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Obj>(() => structuredClone(initial as Obj));

  function update(fn: (d: Obj) => void) {
    setDraft((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }
  const ta = (value: string, rows: number, onChange: (v: string) => void, label: string) => (
    <div>
      <Label>{label}</Label>
      <textarea className={inputClass} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );

  return (
    <div className="space-y-5">
      <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">
        You can reword or remove any item. Items keep the entries they cite (shown as ID chips) and cannot be given new sources here. Saving clears the &quot;reviewed&quot; mark, so you confirm the final text before it goes out.
      </p>
      {SECTIONS[kind].map((sec) => (
        <div key={sec.key}>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{sec.title}</h4>
          <div className="space-y-3">
            {arr(draft[sec.key]).length === 0 && <p className="text-sm italic text-slate-500">None.</p>}
            {arr(draft[sec.key]).map((item, i) => (
              <div key={i} className="rounded-xl border border-slate-200 p-3">
                <div className="space-y-2">
                  {sec.fields.map((f) => ta(String(item[f.k] ?? ""), f.rows ?? 3, (v) => update((d) => { arr(d[sec.key])[i][f.k] = v; }), f.label))}
                  {Array.isArray(item.source_ids) && (
                    <p className="text-xs text-slate-500">
                      Sources: <SourceChips ids={item.source_ids as string[]} />
                    </p>
                  )}
                  {sec.nested &&
                    arr(item[sec.nested.key]).map((p, j) => (
                      <div key={j} className="ml-4 border-l-2 border-amber-200 pl-3">
                        {sec.nested!.fields.map((f) => ta(String(p[f.k] ?? ""), f.rows ?? 2, (v) => update((d) => { arr(arr(d[sec.key])[i][sec.nested!.key])[j][f.k] = v; }), `${sec.nested!.title} ${j + 1}`))}
                        <p className="text-xs text-slate-500">
                          Sources: <SourceChips ids={(p.source_ids as string[]) ?? []} />
                        </p>
                      </div>
                    ))}
                </div>
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => update((d) => { arr(d[sec.key]).splice(i, 1); })}>
                  Remove this item
                </Button>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Limits shown with this summary</h4>
        {((draft.caveats as string[]) ?? []).map((c, i) => (
          <div key={i} className="mb-2 flex items-start gap-2">
            <textarea aria-label={`Limit ${i + 1}`} className={inputClass} rows={2} value={c} onChange={(e) => update((d) => { (d.caveats as string[])[i] = e.target.value; })} />
            <Button variant="ghost" size="sm" onClick={() => update((d) => { (d.caveats as string[]).splice(i, 1); })}>
              Remove
            </Button>
          </div>
        ))}
        <p className="text-xs text-slate-500">The standing note that the AI did not watch the video is always re-added.</p>
      </div>
      <div>
        <Label hint="Shown above the summary to participants once published. Not an AI statement: it carries your own words.">Your note (optional)</Label>
        <textarea className={inputClass} rows={2} maxLength={2000} value={String(draft.facilitator_note ?? "")} onChange={(e) => update((d) => { d.facilitator_note = e.target.value; })} />
      </div>
      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={() => onSave(draft)} loading={saving}>
          Save edits
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
