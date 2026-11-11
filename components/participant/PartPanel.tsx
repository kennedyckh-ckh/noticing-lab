"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorMessage, fmtDate, fmtTime } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Modal } from "@/components/ui";
import { EntryCard, SaveBadge, type EntryData, type GuidingQuestion, type SaveState } from "./EntryCard";

export interface PartData {
  locked?: boolean;
  status: "draft" | "submitted" | "locked";
  submitted_at: string | null;
  submitted_by: string | null;
  needs_part1_first?: boolean;
  entries: EntryData[];
  digest: string;
}

export interface Workspace {
  group: { id: string; code: string; name: string; active: boolean };
  session: { id: string; title: string; description: string; video_title: string; video_url: string; part2_unlocked: boolean };
  me: { id: string; name: string };
  members: Array<{ id: string; name: string }>;
  part1: PartData;
  part2: PartData;
  guiding_questions: GuidingQuestion[];
}

interface Incomplete {
  id: string;
  public_id: string;
  missing: string[];
}

export function usePartSaveState() {
  const [states, setStates] = useState<Record<string, SaveState>>({});
  const flushers = useRef(new Map<string, () => Promise<boolean>>());
  const onState = useCallback((id: string, s: SaveState) => {
    setStates((prev) => (prev[id] === s ? prev : { ...prev, [id]: s }));
  }, []);
  const registerFlush = useCallback((id: string, fn: (() => Promise<boolean>) | null) => {
    if (fn) flushers.current.set(id, fn);
    else flushers.current.delete(id);
  }, []);
  const flushAll = useCallback(async (): Promise<boolean> => {
    const results = await Promise.all([...flushers.current.values()].map((f) => f()));
    return results.every(Boolean);
  }, []);
  const values = Object.values(states);
  const worst: SaveState = values.includes("conflict")
    ? "conflict"
    : values.includes("error")
      ? "error"
      : values.includes("invalid")
        ? "invalid"
        : values.includes("saving")
          ? "saving"
          : values.includes("unsaved")
            ? "unsaved"
            : "saved";
  return { onState, registerFlush, flushAll, worst, hasUnsaved: worst !== "saved" };
}

interface Props {
  part: 1 | 2;
  ws: Workspace;
  data: PartData;
  reload: () => Promise<Workspace | null>;
  save: ReturnType<typeof usePartSaveState>;
}

export function PartPanel({ part, ws, data, reload, save }: Props) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [epoch, setEpoch] = useState<Record<string, number>>({});
  const [review, setReview] = useState<{ entries: EntryData[]; digest: string; changed?: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [incomplete, setIncomplete] = useState<Incomplete[]>([]);

  const submitted = data.status === "submitted";
  const canWrite = ws.group.active && !submitted && !(part === 2 && (data.locked || data.needs_part1_first));
  const mine = data.entries.filter((e) => e.mine);
  const others = data.entries.filter((e) => !e.mine);
  const qs = part === 2 ? ws.guiding_questions : [];

  const incompleteById = useMemo(() => new Map(incomplete.map((i) => [i.id, i])), [incomplete]);

  async function addEntry() {
    setAdding(true);
    setError(null);
    try {
      await api("POST", `/api/groups/${ws.group.id}/entries`, { part });
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setAdding(false);
    }
  }

  async function startSubmit() {
    setError(null);
    setPreparing(true);
    try {
      const ok = await save.flushAll();
      if (!ok) {
        setError("Some entries are not saved yet. Fix the problem shown on the entry (or wait for the connection to return), then try again.");
        return;
      }
      const fresh = await reload();
      if (!fresh) {
        setError("Could not load the latest entries. Check your connection and try again.");
        return;
      }
      const p = part === 1 ? fresh.part1 : fresh.part2;
      setIncomplete([]);
      setReview({ entries: p.entries, digest: p.digest });
    } finally {
      setPreparing(false);
    }
  }

  async function confirmSubmit() {
    if (!review) return;
    setSubmitting(true);
    setError(null);
    try {
      await api("POST", `/api/groups/${ws.group.id}/submit`, { part, digest: review.digest });
      setReview(null);
      setNotice(`Part ${part} submitted for ${ws.group.name}. Thank you! It is now locked.`);
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "DIGEST_MISMATCH") {
        const fresh = await reload();
        if (fresh) {
          const p = part === 1 ? fresh.part1 : fresh.part2;
          setReview({ entries: p.entries, digest: p.digest, changed: true });
        }
      } else if (e instanceof ApiError && e.code === "INCOMPLETE_ENTRIES") {
        setIncomplete((e.data.incomplete as Incomplete[]) ?? []);
        setReview(null);
        setError(e.message + ". They are marked below.");
      } else if (e instanceof ApiError && e.code === "NO_ENTRIES") {
        setReview(null);
        setError(e.message);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  // clear "incomplete" markers once the entry has been edited
  useEffect(() => {
    if (incomplete.length === 0) return;
    setIncomplete((prev) =>
      prev.filter((i) => {
        const e = data.entries.find((x) => x.id === i.id);
        return e && (!e.observation.trim() || !e.evidence.trim() || !e.interpretation.trim());
      }),
    );
  }, [data.entries, incomplete.length]);

  // client-side check that mirrors the server's, shown inside the review dialog
  const reviewProblems = review
    ? review.entries.filter((e) => !(e.observation.trim() && e.evidence.trim() && e.interpretation.trim()) && (e.observation || e.evidence || e.interpretation || e.question))
    : [];
  const reviewCount = review ? review.entries.filter((e) => e.observation || e.evidence || e.interpretation || e.question || e.timestamp_sec !== null).length : 0;

  if (part === 2 && data.locked) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-violet-100 text-2xl" aria-hidden>
            🔒
          </div>
          <h2 className="text-lg font-semibold text-slate-900">Part 2 is locked</h2>
          <p className="max-w-md text-sm text-slate-600">
            Your facilitator will open Part 2 when it is time for guided noticing. The guiding questions appear here as soon as it opens, so you can keep this page open.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {part === 2 && (
        <Card title="Guiding questions from your facilitator" subtitle="Use these to look again at the video, then add further noticing. Your Part 1 responses stay as you submitted them.">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-800">
            {ws.guiding_questions.map((q) => (
              <li key={q.id}>{q.text}</li>
            ))}
          </ol>
        </Card>
      )}
      {part === 1 && !submitted && (
        <p className="text-sm text-slate-600">
          Add as many noticing entries as you like. Everyone in your group writes <strong>their own</strong> entries, so nobody overwrites anybody else. When your group is ready, one of you submits Part 1 for the whole group.
        </p>
      )}
      {part === 2 && data.needs_part1_first && <Banner tone="amber">Your group needs to submit Part 1 before it can add Part 2 entries.</Banner>}
      {!ws.group.active && <Banner tone="amber">Your group is marked inactive for this session, so editing is switched off. Ask your facilitator if this is unexpected.</Banner>}
      {submitted && (
        <Banner tone="green">
          <strong>Part {part} was submitted</strong> by {data.submitted_by} on {fmtDate(data.submitted_at)}. It is locked for everyone in {ws.group.name}.
        </Banner>
      )}
      {notice && (
        <Banner tone="green" onClose={() => setNotice(null)}>
          {notice}
        </Banner>
      )}
      {error && (
        <Banner tone="red" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}

      <section aria-label="Your entries" className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Your entries ({mine.length})</h3>
          {canWrite && (
            <Button onClick={addEntry} loading={adding}>
              + Add an entry
            </Button>
          )}
        </div>
        {mine.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">You have not added an entry yet.{canWrite ? " Use “Add an entry” to start." : ""}</p>}
        {mine.map((e) => (
          <EntryCard
            key={`${e.id}:${epoch[e.id] ?? 0}`}
            entry={e}
            editable={canWrite && !e.locked}
            questions={qs}
            highlight={incompleteById.has(e.id) ? `Still needs: ${incompleteById.get(e.id)!.missing.join(", ")}` : null}
            onState={save.onState}
            registerFlush={save.registerFlush}
            onDeleted={() => void reload()}
            onDiscard={(id) => {
              setEpoch((p) => ({ ...p, [id]: (p[id] ?? 0) + 1 }));
              void reload();
            }}
          />
        ))}
      </section>

      <section aria-label="Teammates' entries" className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Teammates&apos; entries ({others.length})</h3>
        {others.length === 0 && <p className="text-sm text-slate-500">Entries from the rest of your group will appear here, read-only.</p>}
        {others.map((e) => (
          <EntryCard key={e.id} entry={e} editable={false} questions={qs} onState={save.onState} registerFlush={save.registerFlush} onDeleted={() => undefined} onDiscard={() => undefined} />
        ))}
      </section>

      {!submitted && canWrite && (
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur">
          <div className="flex items-center gap-3 text-sm text-slate-700">
            <SaveBadge state={save.worst} onRetry={() => void save.flushAll()} />
            <span>
              {data.entries.length} {data.entries.length === 1 ? "entry" : "entries"} in your group ({mine.length} yours)
            </span>
          </div>
          <Button variant="accent" onClick={startSubmit} loading={preparing} disabled={data.entries.length === 0}>
            Submit Part {part} for our group
          </Button>
        </div>
      )}

      <Modal
        open={!!review}
        title={`Submit Part ${part} for ${ws.group.name}?`}
        onClose={() => !submitting && setReview(null)}
        wide
        footer={
          <>
            <Button variant="secondary" onClick={() => setReview(null)} disabled={submitting}>
              Keep editing
            </Button>
            <Button variant="accent" onClick={confirmSubmit} loading={submitting} disabled={reviewProblems.length > 0 || reviewCount === 0}>
              Submit Part {part}
            </Button>
          </>
        }
      >
        {review?.changed && <Banner tone="amber">A teammate changed the group&apos;s entries while you were reviewing. This is the latest list: please check it again.</Banner>}
        <p className="mt-2">
          This submits the work of <strong>everyone in your group</strong> ({reviewCount} {reviewCount === 1 ? "entry" : "entries"}) and <strong>locks Part {part}</strong>. Nobody can edit it afterwards. Completely blank entries are discarded.
        </p>
        {reviewProblems.length > 0 && (
          <div className="mt-3">
            <Banner tone="red">
              These entries still need an observation, evidence and an interpretation: {reviewProblems.map((e) => `${e.public_id} (${e.author.name})`).join(", ")}. Close this window and finish or delete them.
            </Banner>
          </div>
        )}
        <ul className="mt-4 max-h-64 space-y-2 overflow-auto">
          {review?.entries.map((e) => (
            <li key={e.id} className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">
                <code className="font-semibold">{e.public_id}</code> &middot; {e.author.name}
                {e.timestamp_sec !== null && <> &middot; {fmtTime(e.timestamp_sec)}</>}
              </p>
              <p className="mt-0.5 line-clamp-2 text-sm text-slate-800">{e.observation || <em className="text-slate-400">(blank)</em>}</p>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

export function StatusBadge({ data }: { data: PartData }) {
  if (data.locked) return <Badge tone="gray">Locked</Badge>;
  if (data.status === "submitted") return <Badge tone="green">Submitted</Badge>;
  return <Badge tone="amber">Draft</Badge>;
}
