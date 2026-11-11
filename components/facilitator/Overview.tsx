"use client";
import { useState } from "react";
import { api, errorMessage, fmtDate } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Label, Modal, inputClass } from "@/components/ui";
import type { Dash, Detail, PartInfo, Progress } from "./types";

function StatusPill({ p }: { p: PartInfo }) {
  const tone = { locked: "gray", not_started: "gray", draft: "amber", submitted: "green" } as const;
  const label = { locked: "Locked", not_started: "Not started", draft: "Draft", submitted: "Submitted" } as const;
  return (
    <div>
      <Badge tone={tone[p.status]}>{label[p.status]}</Badge>
      {p.status !== "locked" && (
        <p className="mt-1 text-xs text-slate-500">
          {p.entry_count} {p.entry_count === 1 ? "entry" : "entries"} &middot; {p.contributors} {p.contributors === 1 ? "person" : "people"}
          {p.submitted_at && (
            <>
              <br />
              {fmtDate(p.submitted_at)} by {p.submitted_by}
            </>
          )}
        </p>
      )}
    </div>
  );
}

function ProgressCard({ title, p, locked, onOverride }: { title: string; p: Progress; locked?: boolean; onOverride: () => void }) {
  const pct = p.active === 0 ? 0 : Math.round((p.submitted / p.active) * 100);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-600">{title}</p>
          <p className="mt-1 text-2xl font-semibold text-slate-900">
            {locked ? "Locked" : `${p.submitted} of ${p.active}`}
            {!locked && <span className="ml-2 text-base font-normal text-slate-500">active groups submitted</span>}
          </p>
        </div>
        {!locked && p.ready && <Badge tone="green">{p.override_active ? "Proceeding with override" : "All submitted"}</Badge>}
      </div>
      {!locked && (
        <>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${title} submissions`}>
            <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-violet-600 transition-all" style={{ width: `${pct}%` }} />
          </div>
          {p.missing.length > 0 && (
            <div className="mt-3 text-sm text-slate-700">
              <p>
                Waiting for: <strong>{p.missing.map((m) => m.name).join(", ")}</strong>
              </p>
              {!p.override_active && (
                <Button variant="secondary" size="sm" className="mt-2" onClick={onOverride}>
                  Proceed without missing groups...
                </Button>
              )}
              {p.override_active && <p className="mt-1 text-xs text-slate-500">An override is on record for these groups.</p>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function Overview({ dash, detail, reload, openGroup }: { dash: Dash; detail: Detail | null; reload: () => void; openGroup: (gid: string) => void }) {
  const [override, setOverride] = useState<{ part: 1 | 2; thenUnlock: boolean } | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const unlocked = !!dash.session.part2_unlocked_at;
  const p1 = dash.progress.part1;
  const nQuestions = detail?.guiding_questions.length ?? null;

  function close() {
    setOverride(null);
    setUnlockOpen(false);
    setReason("");
    setConfirm("");
    setError(null);
  }

  async function doUnlock() {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/facilitator/sessions/${dash.session.id}/unlock-part2`, {});
      close();
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function doOverride() {
    if (!override) return;
    setBusy(true);
    setError(null);
    try {
      if (override.thenUnlock) {
        await api("POST", `/api/facilitator/sessions/${dash.session.id}/unlock-part2`, { override: { reason, confirm } });
      } else {
        await api("POST", `/api/facilitator/sessions/${dash.session.id}/override`, { part: override.part, reason, confirm });
      }
      close();
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(gid: string, active: boolean) {
    try {
      await api("PATCH", `/api/facilitator/groups/${gid}`, { active });
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const missingForOverride = override ? dash.progress[override.part === 1 ? "part1" : "part2"].missing : [];

  return (
    <div className="space-y-6">
      {error && !override && !unlockOpen && (
        <Banner tone="red" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <p className="text-sm font-medium text-slate-600">Join code for participants</p>
          <p className="mt-1 select-all font-mono text-3xl font-semibold tracking-[0.25em] text-violet-800">{dash.session.join_code}</p>
          <p className="mt-2 text-xs text-slate-500">Participants must also be on a group roster to get in.</p>
        </Card>
        <ProgressCard title="Part 1: Initial noticing" p={dash.progress.part1} onOverride={() => setOverride({ part: 1, thenUnlock: false })} />
        <ProgressCard title="Part 2: Guided noticing" p={dash.progress.part2} locked={!unlocked} onOverride={() => setOverride({ part: 2, thenUnlock: false })} />
      </div>

      <Card
        title="Part 2 release"
        subtitle={unlocked ? `Unlocked ${fmtDate(dash.session.part2_unlocked_at)}. Groups can see the guiding questions and add further noticing.` : "Part 2 stays locked on the server until you release it. Guiding questions are not sent to participants before then."}
        actions={
          unlocked ? (
            <Badge tone="purple">Part 2 open</Badge>
          ) : (
            <Button variant="accent" onClick={() => (p1.ready ? setUnlockOpen(true) : setOverride({ part: 1, thenUnlock: true }))} disabled={nQuestions === 0}>
              Unlock Part 2
            </Button>
          )
        }
      >
        {!unlocked && nQuestions === 0 && <p className="text-sm text-amber-800">Add at least one guiding question (Settings tab) before unlocking Part 2.</p>}
        {!unlocked && nQuestions !== 0 && !p1.ready && (
          <p className="text-sm text-slate-600">
            {p1.submitted} of {p1.active} active groups have submitted Part 1. You can still unlock with a deliberate override.
          </p>
        )}
        {!unlocked && p1.ready && <p className="text-sm text-slate-600">All active groups have submitted Part 1. Unlocking cannot be undone.</p>}
      </Card>

      <Card title="Every group at a glance" subtitle="Draft or submitted status for both parts. Groups marked inactive do not count towards the totals.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-4 font-medium">Group</th>
                <th className="py-2 pr-4 font-medium">People</th>
                <th className="py-2 pr-4 font-medium">Part 1</th>
                <th className="py-2 pr-4 font-medium">Part 2</th>
                <th className="py-2 pr-4 font-medium">Shared</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {dash.groups.map((g) => (
                <tr key={g.id} className={g.active ? "" : "bg-slate-50 text-slate-500"}>
                  <td className="py-3 pr-4 align-top">
                    <p className="font-medium text-slate-900">{g.name}</p>
                    {!g.active && <Badge tone="gray">Inactive</Badge>}
                  </td>
                  <td className="py-3 pr-4 align-top text-slate-600">
                    {g.members.length} joined of {g.authorised_count}
                    <p className="max-w-[12rem] text-xs text-slate-500">{g.members.map((m) => m.name).join(", ")}</p>
                  </td>
                  <td className="py-3 pr-4 align-top">
                    <StatusPill p={g.part1} />
                  </td>
                  <td className="py-3 pr-4 align-top">
                    <StatusPill p={g.part2} />
                  </td>
                  <td className="py-3 pr-4 align-top text-slate-600">{g.shared_count} entries</td>
                  <td className="py-3 align-top">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => openGroup(g.id)}>
                        Read
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggleActive(g.id, !g.active)}>
                        {g.active ? "Mark inactive" : "Mark active"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {dash.overrides.length > 0 && (
        <Card title="Overrides on record" subtitle="Each time you proceeded without every active group.">
          <ul className="space-y-2 text-sm text-slate-700">
            {dash.overrides.map((o) => (
              <li key={o.id}>
                <Badge tone="amber">Part {o.part}</Badge> {fmtDate(o.created_at)}: {o.reason} <span className="text-slate-500">({o.missing_group_ids.length} group{o.missing_group_ids.length === 1 ? "" : "s"} missing)</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={unlockOpen}
        title="Unlock Part 2 for everyone?"
        onClose={close}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button variant="accent" onClick={doUnlock} loading={busy}>
              Unlock Part 2
            </Button>
          </>
        }
      >
        <p>Every group will see your {nQuestions} guiding question{nQuestions === 1 ? "" : "s"} and can add Part 2 entries. Their submitted Part 1 responses stay as they are. This cannot be undone.</p>
        {error && (
          <div className="mt-3">
            <Banner tone="red">{error}</Banner>
          </div>
        )}
      </Modal>

      <Modal
        open={!!override}
        title={override?.thenUnlock ? "Unlock Part 2 without every group?" : `Proceed without missing groups (Part ${override?.part})?`}
        onClose={close}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button variant="danger" onClick={doOverride} loading={busy} disabled={confirm !== "OVERRIDE" || reason.trim().length < 5}>
              {override?.thenUnlock ? "Override and unlock Part 2" : "Record override"}
            </Button>
          </>
        }
      >
        <p>
          These active groups have <strong>not submitted</strong>: <strong>{missingForOverride.map((m) => m.name).join(", ")}</strong>.
        </p>
        <p className="mt-2">Overriding is recorded with your reason. It lets you {override?.thenUnlock ? "unlock Part 2 and " : ""}run cross-group analysis without their work. If another group is added later, a new override is needed.</p>
        <div className="mt-4 space-y-3">
          <div>
            <Label htmlFor="reason">Reason</Label>
            <input id="reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Group 3 left early" />
          </div>
          <div>
            <Label htmlFor="confirm" hint="Type OVERRIDE in capitals to confirm">
              Confirmation
            </Label>
            <input id="confirm" className={inputClass} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </div>
          {error && <Banner tone="red">{error}</Banner>}
        </div>
      </Modal>
    </div>
  );
}
