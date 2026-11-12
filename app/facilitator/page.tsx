 "use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, fmtDate } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Label, Modal, Shell, inputClass } from "@/components/ui";
import { PageLoading, SignOut, useMe } from "@/components/useMe";
import { usePoll } from "@/components/usePoll";

interface Row {
  id: string;
  title: string;
  description: string;
  join_code: string;
  part2_unlocked_at: string | null;
  created_at: string;
  active_groups: number;
  joined: number;
  archived_at: string | null;
  entry_count: number;
}

export default function FacilitatorHome() {
  const me = useMe();
  const list = usePoll<{ sessions: Row[] }>(() => api<{ sessions: Row[] }>("GET", "/api/facilitator/sessions"), 30000);
  const [form, setForm] = useState({ title: "", description: "", video_title: "", video_url: "", num_groups: 3 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [action, setAction] = useState<{ kind: "archive" | "restore" | "delete"; session: Row } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogBody = useRef<HTMLDivElement>(null);
  const sessions = list.data?.sessions ?? [];
  const visibleSessions = sessions.filter((s) => !!s.archived_at === showArchived);

  // Keep keyboard focus inside the confirmation dialog, without changing shared UI.
  useEffect(() => {
    if (!action) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogBody.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
    )).filter((el) => el.getClientRects().length > 0);
    (dialog.querySelector<HTMLElement>("#confirm-session-title") ?? focusable()[0])?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      if (previous?.isConnected) previous.focus();
    };
  }, [action]);

  function openAction(kind: "archive" | "restore" | "delete", session: Row) {
    setAction({ kind, session });
    setActionError(null);
    setConfirmTitle("");
    setAcknowledge(false);
  }

  async function manageSession() {
    if (!action || actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      if (action.kind === "delete") {
        await api("DELETE", `/api/facilitator/sessions/${action.session.id}`, {
          confirm_title: confirmTitle,
          acknowledge_data_loss: acknowledge,
        });
        setNotice(`"${action.session.title}" was permanently deleted. Teacher accounts and other sessions were kept.`);
      } else {
        await api("POST", `/api/facilitator/sessions/${action.session.id}/archive`, {
          archived: action.kind === "archive",
        });
        setNotice(action.kind === "archive"
          ? `"${action.session.title}" was archived. Find it in Archived sessions; its data is unchanged.`
          : `"${action.session.title}" was restored to Current sessions.`);
      }
      setAction(null);
      await list.reload();
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setActionBusy(false);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>("POST", "/api/facilitator/sessions", form);
      window.location.href = `/facilitator/${r.id}`;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (!me) return <PageLoading />;
  if (me.role !== "facilitator") {
    window.location.replace("/");
    return <PageLoading />;
  }
  return (
    <Shell right={<><span className="text-blue-100">{me.name}</span><SignOut /></>} title="Facilitator">
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-slate-900">Your PD sessions</h1>
        <div className="flex flex-wrap gap-2" aria-label="Session list">
          <Button variant={!showArchived ? "primary" : "secondary"} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>
            Current sessions ({sessions.filter((s) => !s.archived_at).length})
          </Button>
          <Button variant={showArchived ? "primary" : "secondary"} aria-pressed={showArchived} onClick={() => setShowArchived(true)}>
            Archived sessions ({sessions.filter((s) => !!s.archived_at).length})
          </Button>
        </div>
        {notice && <Banner tone="green" onClose={() => setNotice(null)}>{notice}</Banner>}
        {showArchived && <Banner tone="gray">Archiving only organises your list. All data is kept, and participants can still access the session. Restore a session at any time, or export its data before permanent deletion.</Banner>}
        <Card>
          {list.error && <Banner tone="red" action={<Button size="sm" variant="secondary" onClick={() => void list.reload()}>Refresh</Button>}>{errorMessage(list.error)} {list.data ? "Showing the last loaded list." : ""}</Banner>}
          {list.loading && !list.data && <p className="text-sm text-slate-600">Loading sessions...</p>}
          {list.data && visibleSessions.length === 0 && <p className="text-sm text-slate-600">{showArchived ? "No archived sessions." : "No current sessions. Create a session below, or restore one from Archived sessions."}</p>}
          <ul className="divide-y divide-slate-100">
            {visibleSessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium text-slate-900">{s.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                    <Badge tone="purple">Code {s.join_code}</Badge>
                    <span>{s.active_groups} active groups</span>
                    <span>&middot; {s.joined} joined</span>
                    <span>&middot; {s.entry_count} entries</span>
                    {s.archived_at && <Badge tone="gray">Archived</Badge>}
                    {s.part2_unlocked_at && <Badge tone="green">Part 2 open</Badge>}
                    <span className="text-slate-400">created {fmtDate(s.created_at)}</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/facilitator/${s.id}`} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">
                    Open dashboard
                  </Link>
                  <Button variant="secondary" onClick={() => openAction(s.archived_at ? "restore" : "archive", s)}>{s.archived_at ? "Restore" : "Archive"}</Button>
                  {s.archived_at && <Button variant="danger" onClick={() => openAction("delete", s)}>Delete</Button>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Create a session" subtitle="Each session has its own groups, responses, guiding questions and sharing settings.">
          <form onSubmit={create} className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label htmlFor="title">Title</Label>
              <input id="title" required className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="desc">Description (shown to participants)</Label>
              <textarea id="desc" rows={2} className={inputClass} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="vt">Video title</Label>
              <input id="vt" className={inputClass} value={form.video_title} onChange={(e) => setForm({ ...form, video_title: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="vu">Video link (optional)</Label>
              <input id="vu" className={inputClass} placeholder="https://" value={form.video_url} onChange={(e) => setForm({ ...form, video_url: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="ng">Number of groups</Label>
              <input id="ng" type="number" min={1} max={12} className={inputClass} value={form.num_groups} onChange={(e) => setForm({ ...form, num_groups: Number(e.target.value) })} />
            </div>
            {error && (
              <div className="md:col-span-2">
                <Banner tone="red">{error}</Banner>
              </div>
            )}
            <div className="md:col-span-2">
              <Button type="submit" loading={busy}>
                Create session
              </Button>
            </div>
          </form>
        </Card>
      </div>
      <Modal
        open={action !== null}
        title={action?.kind === "delete" ? "Permanently delete session?" : action?.kind === "restore" ? "Restore session?" : "Archive session?"}
        onClose={() => { if (!actionBusy) setAction(null); }}
        footer={<>
          <Button variant="secondary" disabled={actionBusy} onClick={() => setAction(null)}>Cancel</Button>
          <Button
            variant={action?.kind === "delete" ? "danger" : "primary"}
            loading={actionBusy}
            disabled={action?.kind === "delete" && (confirmTitle !== action.session.title || !acknowledge)}
            onClick={() => void manageSession()}
          >{action?.kind === "delete" ? "Permanently delete" : action?.kind === "restore" ? "Restore session" : "Archive session"}</Button>
        </>}
      >
        {action && <div ref={dialogBody} className="space-y-4">
          <p className="break-words font-semibold">{action.session.title}</p>
          {action.kind === "delete" ? <>
            <Banner tone="red">This permanently removes this session, its groups, rosters, noticing entries, submissions, guiding questions, sharing settings, and AI summaries. It cannot be undone in the app. Teacher accounts and other sessions are kept.</Banner>
            <p>The list currently shows {action.session.entry_count} entries. This is not a guarantee of the final count: participants can still contribute while a session is archived. Make sure nobody is using it.</p>
            <p><a
              href={`/api/facilitator/sessions/${action.session.id}/export?format=json&what=all`}
              target="_blank" rel="noopener noreferrer"
              className="font-medium text-blue-700 underline"
            >Download session JSON export</a>. This export contains personal data; store it securely. It is an export, not an automatic restore file.</p>
            <label className="flex items-start gap-3">
              <input type="checkbox" className="mt-1" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} disabled={actionBusy} />
              <span>I have exported any data I need, or intentionally do not need it, and understand this permanently deletes the session.</span>
            </label>
            <div>
              <Label htmlFor="confirm-session-title">Type the full session title exactly</Label>
              <input id="confirm-session-title" autoComplete="off" className={inputClass} value={confirmTitle} onChange={(e) => setConfirmTitle(e.target.value)} disabled={actionBusy} />
            </div>
          </> : <p>{action.kind === "restore"
            ? "Move this session back to Current sessions. Its data and join code stay the same."
            : "Move this session to Archived sessions. No data is deleted. Participant access stays unchanged; archiving does not close or lock the workshop."}</p>}
          {actionError && <Banner tone="red">{actionError}</Banner>}
        </div>}
      </Modal>
    </Shell>
  );
}
