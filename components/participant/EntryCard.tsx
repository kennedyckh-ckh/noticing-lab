"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, fmtTime, parseTime } from "@/lib/client/api";
import { Badge, Button, Label, inputClass } from "@/components/ui";

export type SaveState = "saved" | "saving" | "unsaved" | "error" | "conflict" | "invalid";

export interface EntryData {
  id: string;
  public_id: string;
  part: 1 | 2;
  author: { id: string; name: string };
  mine: boolean;
  observation: string;
  timestamp_sec: number | null;
  evidence: string;
  interpretation: string;
  question: string;
  guiding_question_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  locked: boolean;
}

export interface GuidingQuestion {
  id: string;
  position: number;
  text: string;
}

interface Fields {
  observation: string;
  timestamp: string;
  evidence: string;
  interpretation: string;
  question: string;
  guiding_question_id: string;
}

const toFields = (e: EntryData): Fields => ({
  observation: e.observation,
  timestamp: fmtTime(e.timestamp_sec),
  evidence: e.evidence,
  interpretation: e.interpretation,
  question: e.question,
  guiding_question_id: e.guiding_question_id ?? "",
});
const same = (a: Fields, b: Fields) => (Object.keys(a) as Array<keyof Fields>).every((k) => a[k] === b[k]);

const backupKey = (id: string) => `pd-backup:${id}`;
function readBackup(id: string): Fields | null {
  try {
    const raw = localStorage.getItem(backupKey(id));
    return raw ? (JSON.parse(raw) as Fields) : null;
  } catch {
    return null;
  }
}
function writeBackup(id: string, f: Fields) {
  try {
    localStorage.setItem(backupKey(id), JSON.stringify(f));
  } catch {
    /* storage full or blocked: autosave to the server still works */
  }
}
function clearBackup(id: string) {
  try {
    localStorage.removeItem(backupKey(id));
  } catch {
    /* ignore */
  }
}

export function SaveBadge({ state, savedAt, onRetry }: { state: SaveState | "locked"; savedAt?: number | null; onRetry?: () => void }) {
  switch (state) {
    case "saved":
      return (
        <Badge tone="green" title={savedAt ? `Saved at ${new Date(savedAt).toLocaleTimeString()}` : undefined}>
          ✓ Saved
        </Badge>
      );
    case "saving":
      return <Badge tone="blue">Saving...</Badge>;
    case "unsaved":
      return <Badge tone="amber">Unsaved changes</Badge>;
    case "invalid":
      return <Badge tone="amber">Not saved: fix the timestamp</Badge>;
    case "conflict":
      return <Badge tone="red">Not saved: changed elsewhere</Badge>;
    case "error":
      return (
        <span className="inline-flex items-center gap-2">
          <Badge tone="red">Not saved</Badge>
          {onRetry && (
            <button onClick={onRetry} className="text-xs font-medium text-red-700 underline">
              Retry now
            </button>
          )}
        </span>
      );
    case "locked":
      return <Badge tone="gray">Submitted</Badge>;
  }
}

interface Props {
  entry: EntryData;
  editable: boolean;
  questions: GuidingQuestion[];
  highlight?: string | null; // message when the entry blocks submission
  onState: (id: string, s: SaveState) => void;
  registerFlush: (id: string, fn: (() => Promise<boolean>) | null) => void;
  onDeleted: () => void;
  onDiscard: (id: string) => void;
}

export function EntryCard({ entry, editable, questions, highlight, onState, registerFlush, onDeleted, onDiscard }: Props) {
  const [fields, setFields] = useState<Fields>(() => toFields(entry));
  const [status, setStatus] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState<Fields | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fieldsRef = useRef<Fields>(fields);
  const savedRef = useRef<Fields>(toFields(entry));
  const versionRef = useRef(entry.version);
  const statusRef = useRef<SaveState>("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const inflight = useRef<Promise<boolean> | null>(null);
  const unmounted = useRef(false);
  const conflictVersion = useRef<number | null>(null);

  const setSave = useCallback(
    (s: SaveState) => {
      statusRef.current = s;
      if (!unmounted.current) setStatus(s);
      onState(entry.id, s);
    },
    [entry.id, onState],
  );

  const runSave = useCallback((): Promise<boolean> => {
    if (inflight.current) return inflight.current;
    const p = (async () => {
      for (;;) {
        const snap = fieldsRef.current;
        if (same(snap, savedRef.current)) {
          setSave("saved");
          return true;
        }
        const ts = parseTime(snap.timestamp);
        if (ts === undefined) {
          setSave("invalid");
          return false;
        }
        setSave("saving");
        try {
          const r = await api<{ entry: EntryData }>("PATCH", `/api/entries/${entry.id}`, {
            base_version: versionRef.current,
            observation: snap.observation,
            timestamp: ts,
            evidence: snap.evidence,
            interpretation: snap.interpretation,
            question: snap.question,
            guiding_question_id: snap.guiding_question_id || null,
          });
          versionRef.current = r.entry.version;
          savedRef.current = snap;
          attempts.current = 0;
          setMessage(null);
          if (!unmounted.current) setSavedAt(Date.now());
          if (same(fieldsRef.current, snap)) clearBackup(entry.id);
        } catch (e) {
          if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
            if (!unmounted.current) setMessage(e.message);
            conflictVersion.current = typeof e.data.current_version === "number" ? e.data.current_version : null;
            setSave("conflict");
            return false;
          }
          if (e instanceof ApiError && !e.isNetwork && e.status >= 400 && e.status < 500 && e.status !== 429) {
            if (!unmounted.current) setMessage(e.message);
            setSave("error"); // locked, permission change, validation: retrying will not help
            return false;
          }
          if (!unmounted.current) setMessage(e instanceof Error ? e.message : "Could not save");
          setSave("error");
          attempts.current += 1;
          if (attempts.current <= 6 && !unmounted.current) {
            if (retryTimer.current) clearTimeout(retryTimer.current);
            retryTimer.current = setTimeout(() => void runSave(), Math.min(30000, 3000 * attempts.current));
          }
          return false;
        }
      }
    })().finally(() => {
      inflight.current = null;
    });
    inflight.current = p;
    return p;
  }, [entry.id, setSave]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inflight.current) await inflight.current;
    return runSave();
  }, [runSave]);

  useEffect(() => {
    unmounted.current = false;
    registerFlush(entry.id, editable ? flush : null);
    return () => {
      unmounted.current = true;
      registerFlush(entry.id, null);
      if (timer.current) clearTimeout(timer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      onState(entry.id, "saved"); // an unmounted card no longer holds unsaved work (its backup stays on this device)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, editable, flush]);

  // A local backup left by a crashed tab or a failed network save
  useEffect(() => {
    if (!editable) return;
    const b = readBackup(entry.id);
    if (b && !same(b, toFields(entry))) setRecoverable(b);
    else if (b) clearBackup(entry.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  // Pick up a newer server version (e.g. edited in another tab) only when nothing local is pending
  useEffect(() => {
    if (entry.version > versionRef.current && statusRef.current === "saved" && !inflight.current) {
      const f = toFields(entry);
      fieldsRef.current = f;
      savedRef.current = f;
      versionRef.current = entry.version;
      setFields(f);
    }
  }, [entry]);

  function change<K extends keyof Fields>(k: K, v: Fields[K]) {
    const next = { ...fieldsRef.current, [k]: v };
    fieldsRef.current = next;
    setFields(next);
    writeBackup(entry.id, next);
    if (!inflight.current) setSave("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSave(), 900);
  }

  function restore() {
    if (!recoverable) return;
    fieldsRef.current = recoverable;
    setFields(recoverable);
    setRecoverable(null);
    setSave("unsaved");
    void runSave();
  }

  function keepMine() {
    if (conflictVersion.current !== null) versionRef.current = conflictVersion.current;
    attempts.current = 0;
    void runSave();
  }

  async function remove() {
    const hasContent = fields.observation || fields.evidence || fields.interpretation || fields.question;
    if (hasContent && !window.confirm("Delete this entry? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await api("DELETE", `/api/entries/${entry.id}`);
      clearBackup(entry.id);
      onDeleted();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not delete");
      setDeleting(false);
    }
  }

  const q = questions.find((x) => x.id === (editable ? fields.guiding_question_id : entry.guiding_question_id));
  const locked = entry.locked;
  const ring = highlight ? "ring-2 ring-red-300" : entry.mine ? "ring-1 ring-slate-200" : "ring-1 ring-slate-200 bg-slate-50/60";

  return (
    <article className={`rounded-2xl bg-white p-5 shadow-sm ${ring}`} aria-label={`Entry ${entry.public_id}`}>
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{entry.public_id}</code>
          <span className="text-sm text-slate-600">{entry.mine ? "You" : entry.author.name}</span>
          {q && <Badge tone="purple">Re: {q.text.length > 48 ? q.text.slice(0, 48) + "..." : q.text}</Badge>}
        </div>
        <div className="flex items-center gap-3">
          {editable ? <SaveBadge state={status} savedAt={savedAt} onRetry={() => void flush()} /> : locked ? <SaveBadge state="locked" /> : null}
          {editable && (
            <Button variant="ghost" size="sm" onClick={remove} loading={deleting} aria-label={`Delete entry ${entry.public_id}`}>
              Delete
            </Button>
          )}
        </div>
      </header>

      {highlight && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{highlight}</p>}
      {message && (status === "error" || status === "conflict") && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>}
      {status === "conflict" && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={keepMine}>
            Keep my text and save it
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onDiscard(entry.id)}>
            Discard my text, load the saved version
          </Button>
        </div>
      )}
      {recoverable && editable && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>We found text from this browser that was never saved to the server.</span>
          <span className="flex gap-2">
            <Button size="sm" onClick={restore}>
              Restore it
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                clearBackup(entry.id);
                setRecoverable(null);
              }}
            >
              Discard
            </Button>
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[1fr_9rem]">
        <Field label="What did you notice?" hint="Describe what happened, as you saw or heard it." value={fields.observation} editable={editable} rows={3} onChange={(v) => change("observation", v)} id={`${entry.id}-obs`} />
        <div>
          <Label htmlFor={`${entry.id}-ts`} hint="Optional, e.g. 1:30">
            Video time
          </Label>
          {editable ? (
            <input id={`${entry.id}-ts`} className={`${inputClass} ${parseTime(fields.timestamp) === undefined ? "border-red-400" : ""}`} inputMode="numeric" placeholder="m:ss" maxLength={9} value={fields.timestamp} onChange={(e) => change("timestamp", e.target.value)} />
          ) : (
            <p className="text-sm text-slate-800">{fields.timestamp || <span className="text-slate-400">-</span>}</p>
          )}
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="Evidence from the video" hint="What exactly did you see or hear that supports this?" value={fields.evidence} editable={editable} rows={3} onChange={(v) => change("evidence", v)} id={`${entry.id}-ev`} />
        <Field label="Your interpretation" hint="What might it mean for students' thinking or learning?" value={fields.interpretation} editable={editable} rows={3} onChange={(v) => change("interpretation", v)} id={`${entry.id}-int`} />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor={`${entry.id}-q`} hint="Optional">
            A question you have
          </Label>
          {editable ? (
            <input id={`${entry.id}-q`} className={inputClass} maxLength={1000} value={fields.question} onChange={(e) => change("question", e.target.value)} />
          ) : (
            <p className="text-sm text-slate-800">{fields.question || <span className="text-slate-400">-</span>}</p>
          )}
        </div>
        {entry.part === 2 && questions.length > 0 && editable && (
          <div>
            <Label htmlFor={`${entry.id}-gq`} hint="Optional">
              Responding to guiding question
            </Label>
            <select id={`${entry.id}-gq`} className={inputClass} value={fields.guiding_question_id} onChange={(e) => change("guiding_question_id", e.target.value)}>
              <option value="">General noticing</option>
              {questions.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.position}. {g.text.length > 70 ? g.text.slice(0, 70) + "..." : g.text}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </article>
  );
}

function Field({ label, hint, value, editable, rows, onChange, id }: { label: string; hint: string; value: string; editable: boolean; rows: number; onChange: (v: string) => void; id: string }) {
  return (
    <div>
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      {editable ? (
        <textarea id={id} className={inputClass} rows={rows} maxLength={3000} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <p className="whitespace-pre-wrap text-sm text-slate-800">{value || <span className="text-slate-400">-</span>}</p>
      )}
    </div>
  );
}
