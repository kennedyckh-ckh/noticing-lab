"use client";
import { useState } from "react";
import { ApiError, api, errorMessage, fmtDate } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Label, Modal, Spinner, inputClass } from "@/components/ui";
import { AiContentView } from "@/components/AiContentView";
import { usePoll } from "@/components/usePoll";
import type { AiKind } from "@/lib/ai/types";
import { AiEditor } from "./AiEditor";
import type { Dash, Detail } from "./types";

interface Output {
  id: string;
  kind: AiKind;
  group: { id: string; code: string; name: string } | null;
  part: "1" | "2" | "both";
  status: "draft" | "published";
  provider: string;
  model: string;
  simulated: boolean;
  criteria: string;
  generated: unknown;
  content: unknown;
  edited: boolean;
  warnings: string[];
  reviewed_at: string | null;
  published_at: string | null;
  created_at: string;
}
interface AiList {
  provider: { name: string; simulated: boolean; model: string; reason: string };
  outputs: Output[];
}

const KIND_TITLE: Record<AiKind, string> = { group_summary: "Group summaries", cross_group: "Cross-group comparisons (facilitator only)", salient_points: "Salient discussion points" };
const partLabel = (p: string) => (p === "both" ? "Parts 1 and 2" : `Part ${p}`);

export function AiTab({ dash, detail, reloadDash }: { dash: Dash; detail: Detail | null; reloadDash: () => void }) {
  const list = usePoll<AiList>(() => api<AiList>("GET", `/api/facilitator/sessions/${dash.session.id}/ai`), 20000, [dash.session.id]);
  const [part, setPart] = useState<"1" | "2" | "both">("1");
  const [criteria, setCriteria] = useState(detail?.session.salient_criteria ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState<{ part: 1 | 2; retry: () => void } | null>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [publishing, setPublishing] = useState<null | "group_summary" | "salient_points">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sid = dash.session.id;
  const unlocked = !!dash.session.part2_unlocked_at;

  async function generate(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    try {
      await api("POST", `/api/facilitator/sessions/${sid}/ai/generate`, body);
      await list.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "MISSING_SUBMISSIONS") {
        const p = Number(e.data.part) === 2 ? 2 : 1;
        setOverride({ part: p, retry: () => void generate(body, key) });
      } else setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function doOverride() {
    if (!override) return;
    try {
      await api("POST", `/api/facilitator/sessions/${sid}/override`, { part: override.part, reason, confirm });
      const retry = override.retry;
      setOverride(null);
      setReason("");
      setConfirm("");
      reloadDash();
      retry();
    } catch (e) {
      setError(errorMessage(e));
      setOverride(null);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await list.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function publish(kind: "group_summary" | "salient_points") {
    setBusy("publish");
    try {
      const path = kind === "group_summary" ? "publish-summaries" : "reveal-salient";
      const r = await api<{ published: number }>("POST", `/api/facilitator/sessions/${sid}/ai/${path}`, {});
      setNotice(`${r.published} ${kind === "group_summary" ? "group summar" + (r.published === 1 ? "y" : "ies") : "set of salient points"} now visible to participants.`);
      setPublishing(null);
      await list.reload();
    } catch (e) {
      setError(errorMessage(e));
      setPublishing(null);
    } finally {
      setBusy(null);
    }
  }

  const outs = list.data?.outputs ?? [];
  const reviewedDrafts = (k: AiKind) => outs.filter((o) => o.kind === k && o.status === "draft" && o.reviewed_at);
  const partsNeeded: Array<1 | 2> = part === "both" ? [1, 2] : part === "1" ? [1] : [2];
  const submittedFor = (g: Dash["groups"][number]) => partsNeeded.every((p) => (p === 1 ? g.part1 : g.part2).status === "submitted");
  const submittedGroups = dash.groups.filter(submittedFor);

  if (list.loading && !list.data) return <p className="text-sm text-slate-500">Loading...</p>;
  const prov = list.data?.provider;

  return (
    <div className="space-y-6">
      {prov && (
        <Banner tone={prov.simulated ? "amber" : "blue"}>
          {prov.simulated ? (
            <>
              <strong>Demo mode: simulated AI.</strong> {prov.reason} The drafts below are produced by a rule-based simulator so you can try the review and publishing flow. They are labelled as simulated for you and for participants. Set <code>ANTHROPIC_API_KEY</code> on the server to use a real model.
            </>
          ) : (
            <>
              <strong>Real model connected:</strong> {prov.model}. Drafts are checked for valid citations, but they are still drafts: read them against the entries before you publish.
            </>
          )}
        </Banner>
      )}
      {error && (
        <Banner tone="red" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}
      {notice && (
        <Banner tone="green" onClose={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      <Card title="1. Generate drafts" subtitle="The AI reads only submitted work, never drafts in progress. Participants cannot see anything you generate until you review and publish it.">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-700">Analyse:</span>
          {(["1", "2", "both"] as const).map((p) => (
            <button key={p} disabled={p !== "1" && !unlocked} onClick={() => setPart(p)} className={`rounded-full px-3 py-1.5 ring-1 ring-inset disabled:opacity-40 ${part === p ? "bg-blue-700 text-white ring-blue-700" : "bg-white text-slate-700 ring-slate-300"}`}>
              {partLabel(p)}
            </button>
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900">Group summaries</h3>
            <p className="mt-1 text-xs text-slate-600">One summary per group, separating what was observed from how it was interpreted, with disagreements kept visible.</p>
            <ul className="mt-3 space-y-2">
              {dash.groups.map((g) => (
                <li key={g.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className={g.active ? "" : "text-slate-400"}>{g.name}</span>
                  <Button size="sm" variant="secondary" disabled={!submittedFor(g)} loading={busy === `gs-${g.id}`} onClick={() => generate({ kind: "group_summary", group_id: g.id, part }, `gs-${g.id}`)}>
                    {submittedFor(g) ? "Generate" : "Not submitted"}
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              className="mt-3"
              disabled={submittedGroups.length === 0 || !!busy}
              loading={busy === "gs-all"}
              onClick={async () => {
                setBusy("gs-all");
                setError(null);
                try {
                  for (const g of submittedGroups) await api("POST", `/api/facilitator/sessions/${sid}/ai/generate`, { kind: "group_summary", group_id: g.id, part });
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  await list.reload();
                  setBusy(null);
                }
              }}
            >
              Generate for all submitted groups ({submittedGroups.length})
            </Button>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900">Cross-group comparison</h3>
            <p className="mt-1 text-xs text-slate-600">Common ground, differences and single-group noticings across active groups. For you only: it cannot be published to participants.</p>
            <p className="mt-3 text-sm text-slate-700">
              {partsNeeded.map((p) => {
                const pr = dash.progress[p === 1 ? "part1" : "part2"];
                return (
                  <span key={p} className="block">
                    Part {p}: {pr.submitted} of {pr.active} active groups submitted{pr.missing.length > 0 && pr.override_active ? " (override on record)" : ""}
                  </span>
                );
              })}
            </p>
            <Button className="mt-3" size="sm" loading={busy === "cg"} disabled={!!busy} onClick={() => generate({ kind: "cross_group", part }, "cg")}>
              Generate comparison
            </Button>
          </div>

          <div className="rounded-xl border border-slate-200 p-4">
            <h3 className="font-medium text-slate-900">Salient discussion points</h3>
            <p className="mt-1 text-xs text-slate-600">Points worth raising with the whole group, chosen with your criteria.</p>
            <div className="mt-3">
              <Label htmlFor="crit" hint="Defaults to the criteria saved in Settings">
                Your criteria
              </Label>
              <textarea id="crit" rows={4} className={inputClass} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
            </div>
            <Button className="mt-3" size="sm" loading={busy === "sp"} disabled={!!busy || !criteria.trim()} onClick={() => generate({ kind: "salient_points", part, criteria }, "sp")}>
              Generate points
            </Button>
          </div>
        </div>
        {busy && busy !== "publish" && (
          <p className="mt-4 flex items-center gap-2 text-sm text-slate-600">
            <Spinner /> Working... a real model can take up to a minute. Nothing is saved if it fails.
          </p>
        )}
      </Card>

      <Card title="2. Review and edit, then 3. publish" subtitle="Read each draft against the participants' entries (Contributions tab). Edit it if needed, then mark it reviewed. Only reviewed drafts can be published.">
        <div className="mb-5 flex flex-wrap gap-3 rounded-xl bg-slate-50 p-4">
          <Button variant="accent" disabled={reviewedDrafts("group_summary").length === 0} onClick={() => setPublishing("group_summary")}>
            Publish group summaries ({reviewedDrafts("group_summary").length} reviewed)
          </Button>
          <Button variant="accent" disabled={reviewedDrafts("salient_points").length === 0} onClick={() => setPublishing("salient_points")}>
            Reveal salient points ({reviewedDrafts("salient_points").length} reviewed)
          </Button>
          <p className="basis-full text-xs text-slate-600">Two separate buttons: publishing summaries does not reveal salient points, and the other way round.</p>
        </div>
        {outs.length === 0 && <p className="py-4 text-center text-sm text-slate-600">No drafts yet.</p>}
        {(Object.keys(KIND_TITLE) as AiKind[]).map((k) => {
          const rows = outs.filter((o) => o.kind === k);
          if (rows.length === 0) return null;
          return (
            <section key={k} className="mt-6 first:mt-0">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">{KIND_TITLE[k]}</h3>
              <div className="space-y-4">
                {rows.map((o) => (
                  <DraftCard key={o.id} o={o} sid={sid} act={act} />
                ))}
              </div>
            </section>
          );
        })}
      </Card>

      <Modal
        open={!!publishing}
        title={publishing === "group_summary" ? "Publish group summaries?" : "Reveal salient points?"}
        onClose={() => setPublishing(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPublishing(null)}>
              Cancel
            </Button>
            <Button variant="accent" loading={busy === "publish"} onClick={() => publishing && publish(publishing)}>
              {publishing === "group_summary" ? "Publish now" : "Reveal now"}
            </Button>
          </>
        }
      >
        {publishing && (
          <>
            <p>
              Everyone in the session will see {reviewedDrafts(publishing).length} reviewed {publishing === "group_summary" ? "group summaries" : "set(s) of discussion points"} immediately, as they read now, including your edits:
            </p>
            <ul className="mt-2 list-disc pl-5">
              {reviewedDrafts(publishing).map((o) => (
                <li key={o.id}>
                  {o.group?.name ?? "Whole session"} &middot; {partLabel(o.part)}
                  {o.simulated && " (simulated demo output)"}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-slate-600">A newer publication for the same group and part replaces the older one. You can unpublish later.</p>
          </>
        )}
      </Modal>

      <Modal
        open={!!override}
        title={`Continue without the missing groups (Part ${override?.part})?`}
        onClose={() => setOverride(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOverride(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doOverride} disabled={confirm !== "OVERRIDE" || reason.trim().length < 5}>
              Record override and generate
            </Button>
          </>
        }
      >
        <p>Not every active group has submitted this part. Whole-session analysis will leave their work out. This is recorded with your reason and noted in the draft.</p>
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="ar">Reason</Label>
            <input id="ar" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ac" hint="Type OVERRIDE in capitals to confirm">
              Confirmation
            </Label>
            <input id="ac" className={inputClass} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </div>
        </div>
      </Modal>
    </div>
  );
}

function DraftCard({ o, sid, act }: { o: Output; sid: string; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  void sid;
  const [editing, setEditing] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [showWarn, setShowWarn] = useState(false);
  const reviewed = !!o.reviewed_at;

  async function save(content: unknown) {
    setSaving(true);
    setEditError(null);
    try {
      await api("PATCH", `/api/facilitator/ai/${o.id}`, { content });
      setEditing(false);
      await act(async () => undefined);
    } catch (e) {
      setEditError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className={`rounded-2xl border p-5 ${o.status === "published" ? "border-emerald-300 bg-emerald-50/30" : "border-slate-200 bg-white"}`}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium text-slate-900">{o.group?.name ?? "All active groups"}</span>
          <Badge tone="blue">{partLabel(o.part)}</Badge>
          {o.simulated ? <Badge tone="amber">Simulated, not AI</Badge> : <Badge tone="purple">{o.model}</Badge>}
          {o.edited && <Badge tone="gray">Edited by you</Badge>}
          {o.status === "published" ? <Badge tone="green">Published {fmtDate(o.published_at)}</Badge> : reviewed ? <Badge tone="green">Reviewed</Badge> : <Badge tone="amber">Draft: not reviewed</Badge>}
          <span className="text-xs text-slate-400">generated {fmtDate(o.created_at)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {o.status === "published" ? (
            <Button size="sm" variant="secondary" onClick={() => act(() => api("POST", `/api/facilitator/ai/${o.id}/unpublish`))}>
              Unpublish
            </Button>
          ) : (
            <>
              {!editing && (
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              <Button size="sm" variant={reviewed ? "secondary" : "primary"} onClick={() => act(() => api("POST", `/api/facilitator/ai/${o.id}/review`, { reviewed: !reviewed }))}>
                {reviewed ? "Remove reviewed mark" : "Mark as reviewed"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (window.confirm("Delete this draft?")) void act(() => api("DELETE", `/api/facilitator/ai/${o.id}`));
                }}
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </header>
      {o.kind === "salient_points" && o.criteria && (
        <p className="mb-3 rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">
          <strong>Criteria used:</strong> {o.criteria}
        </p>
      )}
      {o.warnings.length > 0 && (
        <div className="mb-3">
          <button onClick={() => setShowWarn(!showWarn)} className="text-xs font-medium text-amber-800 underline">
            {o.warnings.length} check note{o.warnings.length === 1 ? "" : "s"} from the automatic validator {showWarn ? "(hide)" : "(show)"}
          </button>
          {showWarn && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-900">
              {o.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing ? (
        <AiEditor kind={o.kind} initial={o.content} saving={saving} error={editError} onSave={save} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <AiContentView kind={o.kind} content={showOriginal ? o.generated : o.content} />
          {o.edited && (
            <button onClick={() => setShowOriginal(!showOriginal)} className="mt-3 text-xs text-blue-700 underline">
              {showOriginal ? "Show your edited version" : "Show the original AI version"}
            </button>
          )}
        </>
      )}
    </article>
  );
}
