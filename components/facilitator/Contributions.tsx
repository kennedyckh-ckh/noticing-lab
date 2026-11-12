"use client";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, fmtDate, fmtTime } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Label, Modal, inputClass } from "@/components/ui";
import { usePoll } from "@/components/usePoll";
import type { Dash, Detail } from "./types";

interface Contrib {
  group: { id: string; code: string; name: string; active: boolean };
  submissions: Array<{ part: number; submitted_at: string; submitted_by: string }>;
  entries: Array<{
    id: string;
    public_id: string;
    part: number;
    stage_label: string;
    author: { id: string; name: string };
    observation: string;
    timestamp_sec: number | null;
    evidence: string;
    interpretation: string;
    question: string;
    guiding_question_id: string | null;
    created_at: string;
    updated_at: string;
    submitted: boolean;
    shared: boolean;
    show_author: boolean;
  }>;
}

export function Contributions({ dash, detail, groupId, setGroupId, reloadDash }: { dash: Dash; detail: Detail | null; groupId: string; setGroupId: (g: string) => void; reloadDash: () => void }) {
  const [partFilter, setPartFilter] = useState<0 | 1 | 2>(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reopening, setReopening] = useState<{ id: string; name: string; submitted_at: string } | null>(null);
  const [reopenBusy, setReopenBusy] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const reopenDialogBody = useRef<HTMLDivElement>(null);
  const sid = dash.session.id;
  const c = usePoll<Contrib>(() => api<Contrib>("GET", `/api/facilitator/sessions/${sid}/groups/${groupId}/entries`), 10000, [sid, groupId]);
  const qText = new Map(detail?.guiding_questions.map((q) => [q.id, `${q.position}. ${q.text}`]) ?? []);
  const selectedData = c.data?.group.id === groupId ? c.data : null;
  const part1Submission = selectedData?.submissions.find((s) => s.part === 1);

  useEffect(() => {
    if (!reopening) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = reopenDialogBody.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    dialog.querySelector<HTMLElement>("#reopen-reason")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)"));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [reopening]);

  async function reopen() {
    if (!reopening || reopenBusy) return;
    setReopenBusy(true);
    setReopenError(null);
    try {
      await api("POST", `/api/facilitator/sessions/${sid}/groups/${reopening.id}/reopen-part1`, {
        reason, confirm: confirmation, submitted_at: reopening.submitted_at,
      });
      setNotice(`Part 1 reopened for ${reopening.name}. Existing entries are kept. Each teacher can edit their own entries, and one group member can submit again. Affected shared work and AI analyses have been withdrawn.`);
      setReopening(null);
      await c.reload();
      reloadDash();
    } catch (e) {
      setReopenError(errorMessage(e));
    } finally {
      setReopenBusy(false);
    }
  }

  async function share(entryId: string, shared: boolean, showAuthor: boolean) {
    setError(null);
    try {
      await api("POST", `/api/facilitator/entries/${entryId}/share`, { shared, show_author: showAuthor });
      await c.reload();
      reloadDash();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const entries = (c.data?.entries ?? []).filter((e) => partFilter === 0 || e.part === partFilter);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {dash.groups.map((g) => (
          <button key={g.id} onClick={() => setGroupId(g.id)} className={`rounded-full px-4 py-1.5 text-sm font-medium ring-1 ring-inset ${g.id === groupId ? "bg-violet-700 text-white ring-violet-700" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>
            {g.name}
            {!g.active && " (inactive)"}
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-slate-300" />
        {([0, 1, 2] as const).map((p) => (
          <button key={p} onClick={() => setPartFilter(p)} className={`rounded-full px-3 py-1.5 text-sm ring-1 ring-inset ${partFilter === p ? "bg-blue-700 text-white ring-blue-700" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>
            {p === 0 ? "Both parts" : `Part ${p}`}
          </button>
        ))}
      </div>

      {selectedData && (
        <Card title="Part 1 resubmission" actions={
          <Button variant="secondary" disabled={!part1Submission || !selectedData.group.active || reopenBusy} onClick={() => {
            if (!part1Submission) return;
            setReopening({ id: selectedData.group.id, name: selectedData.group.name, submitted_at: part1Submission.submitted_at });
            setReason("");
            setConfirmation("");
            setReopenError(null);
          }}>Reopen Part 1</Button>
        }>
          <p className="text-sm text-slate-600">{!selectedData.group.active
            ? "Mark this group active in Groups & people before reopening its work."
            : part1Submission
              ? `Allow ${selectedData.group.name} to revise and resubmit Part 1 without deleting their entries.`
              : "Part 1 is already open for editing. No reopening is needed until this group submits."}</p>
        </Card>
      )}
      {notice && <Banner tone="green" onClose={() => setNotice(null)}>{notice}</Banner>}
      {!dash.session.sharing_enabled && <Banner tone="amber">Sharing is switched off for this session (Settings tab). Entries you mark as shared stay hidden from participants until you switch it back on.</Banner>}
      {error && (
        <Banner tone="red" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}
      {c.error && !c.data && <Banner tone="red">{errorMessage(c.error)}</Banner>}
      {c.data && (
        <p className="text-sm text-slate-600">
          {c.data.submissions.length === 0 ? "This group has not submitted anything yet. You are reading live drafts." : c.data.submissions.map((s) => `Part ${s.part} submitted ${fmtDate(s.submitted_at)} by ${s.submitted_by}`).join(" · ")}
        </p>
      )}
      {c.data && entries.length === 0 && (
        <Card>
          <p className="py-6 text-center text-sm text-slate-600">No entries to show.</p>
        </Card>
      )}
      {entries.map((e) => (
        <article key={e.id} className={`rounded-2xl border bg-white p-5 shadow-sm ${e.shared ? "border-violet-300" : "border-slate-200"}`}>
          <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <code className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{e.public_id}</code>
              <Badge tone={e.part === 1 ? "blue" : "purple"}>{e.stage_label}</Badge>
              <Badge tone={e.submitted ? "green" : "amber"}>{e.submitted ? "Submitted" : "Draft"}</Badge>
              <span>{e.author.name}</span>
              {e.timestamp_sec !== null && <Badge tone="gray">at {fmtTime(e.timestamp_sec)}</Badge>}
              <span className="text-xs text-slate-400">edited {fmtDate(e.updated_at)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className={`flex items-center gap-2 ${e.submitted ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`} title={e.submitted ? "" : "Only submitted entries can be shared"}>
                <input type="checkbox" disabled={!e.submitted} checked={e.shared} onChange={(ev) => share(e.id, ev.target.checked, e.show_author)} />
                Share with participants
              </label>
              {e.shared && (
                <label className="flex cursor-pointer items-center gap-2 text-slate-600">
                  <input type="checkbox" checked={e.show_author} onChange={(ev) => share(e.id, true, ev.target.checked)} />
                  Show contributor name
                </label>
              )}
            </div>
          </header>
          {e.guiding_question_id && <p className="mb-2 text-xs text-violet-800">Responding to: {qText.get(e.guiding_question_id) ?? "a guiding question"}</p>}
          <dl className="grid gap-3 text-sm text-slate-800 md:grid-cols-2">
            <div className="md:col-span-2">
              <dt className="text-xs font-semibold uppercase tracking-wide text-blue-800">Observation</dt>
              <dd className="whitespace-pre-wrap">{e.observation || <em className="text-slate-400">empty</em>}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Evidence</dt>
              <dd className="whitespace-pre-wrap">{e.evidence || <em className="text-slate-400">empty</em>}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-violet-800">Interpretation</dt>
              <dd className="whitespace-pre-wrap">{e.interpretation || <em className="text-slate-400">empty</em>}</dd>
            </div>
            {e.question && (
              <div className="md:col-span-2">
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Question</dt>
                <dd className="whitespace-pre-wrap">{e.question}</dd>
              </div>
            )}
          </dl>
        </article>
      ))}
      <div>
        <Button variant="ghost" size="sm" onClick={() => void c.reload()}>
          Refresh now
        </Button>
      </div>
      <Modal
        open={!!reopening}
        title={`Reopen Part 1 for ${reopening?.name ?? "this group"}?`}
        onClose={() => { if (!reopenBusy) setReopening(null); }}
        footer={<>
          <Button variant="secondary" disabled={reopenBusy} onClick={() => setReopening(null)}>Cancel</Button>
          <Button variant="accent" loading={reopenBusy} disabled={reason.trim().length < 5 || confirmation !== "REOPEN"} onClick={() => void reopen()}>
            Reopen Part 1 for editing
          </Button>
        </>}
      >
        <div ref={reopenDialogBody} className="space-y-4">
          <p>This keeps every current entry and saves a copy of the previous submission. Teachers can edit their own entries again; one group member then submits Part 1 for the whole group.</p>
          <Banner tone="amber">Previously shared Part 1 entries from this group will be unshared. This group&apos;s Part 1 or combined AI summaries, and whole-session analyses involving Part 1, will be marked outdated and unpublished. Generate fresh analyses after resubmission, then review and publish them.</Banner>
          <p>Part 2 is not reset or relocked. Its existing entries and submissions stay unchanged; further Part 2 editing waits until Part 1 is resubmitted. If Part 2 has already opened, revised Part 1 work is no longer a strictly unguided first response.</p>
          <div>
            <Label htmlFor="reopen-reason">Reason for reopening</Label>
            <textarea id="reopen-reason" rows={2} maxLength={500} className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} disabled={reopenBusy} />
          </div>
          <div>
            <Label htmlFor="reopen-confirm">Type REOPEN to confirm</Label>
            <input id="reopen-confirm" autoComplete="off" className={inputClass} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={reopenBusy} />
          </div>
          {reopenError && <Banner tone="red">{reopenError}</Banner>}
        </div>
      </Modal>
    </div>
  );
}
