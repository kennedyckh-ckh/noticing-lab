"use client";
import type { ReactNode } from "react";
import type { AiKind, CrossGroupContent, GroupSummaryContent, SalientContent } from "@/lib/ai/types";

export function SourceChips({ ids }: { ids: string[] }) {
  if (!ids?.length) return <span className="text-xs italic text-amber-700">no source cited</span>;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => (
        <code key={id} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
          {id}
        </code>
      ))}
    </span>
  );
}

function Section({ title, tone, children }: { title: string; tone: string; children: ReactNode }) {
  return (
    <div className="mt-4 first:mt-0">
      <h4 className={`mb-1.5 text-xs font-semibold uppercase tracking-wide ${tone}`}>{title}</h4>
      {children}
    </div>
  );
}

function Empty() {
  return <p className="text-sm italic text-slate-500">None reported.</p>;
}

export function AiContentView({ kind, content }: { kind: AiKind; content: unknown }) {
  if (!content || typeof content !== "object") return <Empty />;
  if (kind === "group_summary") {
    const c = content as GroupSummaryContent;
    return (
      <div className="text-sm text-slate-800">
        {c.facilitator_note && <p className="mb-3 rounded-lg bg-violet-50 p-3 text-violet-900">{c.facilitator_note}</p>}
        <Section title="What the group observed" tone="text-blue-800">
          {c.observations?.length ? (
            <ul className="list-disc space-y-1.5 pl-5">
              {c.observations.map((o, i) => (
                <li key={i}>
                  {o.timestamp && <span className="mr-1 rounded bg-blue-50 px-1.5 text-xs font-medium text-blue-800">{o.timestamp}</span>}
                  {o.text}
                  <SourceChips ids={o.source_ids} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>
        <Section title="How the group interpreted it" tone="text-violet-800">
          {c.interpretations?.length ? (
            <ul className="list-disc space-y-1.5 pl-5">
              {c.interpretations.map((o, i) => (
                <li key={i}>
                  {o.text}
                  <SourceChips ids={o.source_ids} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>
        <Section title="Where members see it differently" tone="text-amber-800">
          {c.disagreements?.length ? (
            <div className="space-y-2">
              {c.disagreements.map((d, i) => (
                <div key={i} className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                  <p className="font-medium">{d.topic}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {d.positions.map((p, j) => (
                      <li key={j}>
                        {p.position}
                        <SourceChips ids={p.source_ids} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <Empty />
          )}
        </Section>
        <Section title="Open questions" tone="text-slate-600">
          {c.open_questions?.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {c.open_questions.map((o, i) => (
                <li key={i}>
                  {o.text}
                  <SourceChips ids={o.source_ids} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>
        <Caveats items={c.caveats} />
      </div>
    );
  }
  if (kind === "cross_group") {
    const c = content as CrossGroupContent;
    return (
      <div className="text-sm text-slate-800">
        {c.facilitator_note && <p className="mb-3 rounded-lg bg-violet-50 p-3 text-violet-900">{c.facilitator_note}</p>}
        <Section title="Common ground" tone="text-blue-800">
          {c.common_ground?.length ? (
            <ul className="list-disc space-y-1.5 pl-5">
              {c.common_ground.map((o, i) => (
                <li key={i}>
                  <span className="mr-1 text-xs font-medium text-slate-500">[{o.groups.join(", ")}]</span>
                  {o.text}
                  <SourceChips ids={o.source_ids} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>
        <Section title="Differences between groups" tone="text-amber-800">
          {c.differences?.length ? (
            <div className="space-y-2">
              {c.differences.map((d, i) => (
                <div key={i} className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
                  <p className="font-medium">{d.topic}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    {d.positions.map((p, j) => (
                      <li key={j}>
                        <strong>{p.group}:</strong> {p.position}
                        <SourceChips ids={p.source_ids} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <Empty />
          )}
        </Section>
        <Section title="Noticed by one group only" tone="text-violet-800">
          {c.unique_noticings?.length ? (
            <ul className="list-disc space-y-1.5 pl-5">
              {c.unique_noticings.map((o, i) => (
                <li key={i}>
                  <strong>{o.group}:</strong> {o.text}
                  <SourceChips ids={o.source_ids} />
                </li>
              ))}
            </ul>
          ) : (
            <Empty />
          )}
        </Section>
        <Caveats items={c.caveats} />
      </div>
    );
  }
  const c = content as SalientContent;
  return (
    <div className="text-sm text-slate-800">
      {c.facilitator_note && <p className="mb-3 rounded-lg bg-violet-50 p-3 text-violet-900">{c.facilitator_note}</p>}
      {c.points?.length ? (
        <ol className="space-y-3">
          {c.points.map((p, i) => (
            <li key={i} className="rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-violet-700 text-xs font-semibold text-white">{i + 1}</span>
                <h4 className="font-semibold text-slate-900">{p.title}</h4>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{p.basis}</span>
              </div>
              <p className="mt-2">
                {p.why_salient}
                <SourceChips ids={p.source_ids} />
              </p>
              {p.criteria_matched?.length > 0 && <p className="mt-1 text-xs text-slate-500">Criteria: {p.criteria_matched.join(" | ")}</p>}
              {p.discussion_prompt && <p className="mt-2 rounded-lg bg-blue-50 p-2.5 text-blue-900">Discuss: {p.discussion_prompt}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <Empty />
      )}
      <Caveats items={c.caveats} />
    </div>
  );
}

function Caveats({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
      <p className="mb-1 font-semibold uppercase tracking-wide text-slate-500">Limits of this summary</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {items.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
    </div>
  );
}
