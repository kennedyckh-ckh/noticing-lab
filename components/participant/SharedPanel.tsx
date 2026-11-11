"use client";
import { api, errorMessage, fmtDate, fmtTime } from "@/lib/client/api";
import { Badge, Banner, Card } from "@/components/ui";
import { AiContentView } from "@/components/AiContentView";
import { usePoll } from "@/components/usePoll";

interface Shared {
  sharing_enabled: boolean;
  entries: Array<{
    public_id: string;
    group: { code: string; name: string };
    part: number;
    stage_label: string;
    observation: string;
    timestamp_sec: number | null;
    evidence: string;
    interpretation: string;
    question: string;
    author_name: string | null;
  }>;
  published_summaries: Array<{ id: string; part: string; group: { code: string; name: string } | null; content: unknown; published_at: string; simulated: boolean }>;
  published_salient: Array<{ id: string; part: string; content: unknown; published_at: string; simulated: boolean }>;
}

const partLabel = (p: string) => (p === "both" ? "Parts 1 and 2" : `Part ${p}`);

export function SharedPanel({ sessionId, onCount }: { sessionId: string; onCount?: (n: number) => void }) {
  const { data, error, loading } = usePoll<Shared>(async () => {
    const r = await api<Shared>("GET", `/api/sessions/${sessionId}/shared`);
    onCount?.(r.entries.length + r.published_summaries.length + r.published_salient.length);
    return r;
  }, 15000, [sessionId]);

  if (loading && !data) return <p className="py-8 text-center text-sm text-slate-500">Loading...</p>;
  if (!data) return <Banner tone="red">{error ? errorMessage(error) : "Could not load"}</Banner>;
  const empty = data.entries.length + data.published_summaries.length + data.published_salient.length === 0;

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">Your facilitator decides what appears here. Other groups&apos; work stays private until it is shared or published.</p>
      {error && <Banner tone="amber">Connection problem: showing what we loaded last. We will keep trying.</Banner>}
      {empty && (
        <Card>
          <p className="py-6 text-center text-sm text-slate-600">Nothing has been shared yet. Selected contributions, group summaries and discussion points will appear here during the discussion.</p>
        </Card>
      )}
      {data.published_salient.map((s) => (
        <Card key={s.id} title="Points for whole-group discussion" subtitle={`${partLabel(s.part)} · published ${fmtDate(s.published_at)}`} actions={s.simulated ? <Badge tone="amber">Demo: simulated, not real AI</Badge> : <Badge tone="purple">AI-assisted, reviewed by your facilitator</Badge>}>
          <AiContentView kind="salient_points" content={s.content} />
        </Card>
      ))}
      {data.published_summaries.map((s) => (
        <Card key={s.id} title={`Summary: ${s.group?.name ?? "Group"}`} subtitle={`${partLabel(s.part)} · published ${fmtDate(s.published_at)}`} actions={s.simulated ? <Badge tone="amber">Demo: simulated, not real AI</Badge> : <Badge tone="purple">AI-assisted, reviewed by your facilitator</Badge>}>
          <AiContentView kind="group_summary" content={s.content} />
        </Card>
      ))}
      {data.entries.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Contributions shared by your facilitator</h3>
          {data.entries.map((e) => (
            <article key={e.public_id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <header className="mb-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <code className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{e.public_id}</code>
                <Badge tone="blue">{e.group.name}</Badge>
                <span>{e.stage_label}</span>
                {e.timestamp_sec !== null && <Badge tone="gray">at {fmtTime(e.timestamp_sec)}</Badge>}
                {e.author_name && <span>by {e.author_name}</span>}
              </header>
              <dl className="space-y-2 text-sm text-slate-800">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-blue-800">Noticed</dt>
                  <dd className="whitespace-pre-wrap">{e.observation}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Evidence</dt>
                  <dd className="whitespace-pre-wrap">{e.evidence}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-violet-800">Interpretation</dt>
                  <dd className="whitespace-pre-wrap">{e.interpretation}</dd>
                </div>
                {e.question && (
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Question</dt>
                    <dd className="whitespace-pre-wrap">{e.question}</dd>
                  </div>
                )}
              </dl>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
