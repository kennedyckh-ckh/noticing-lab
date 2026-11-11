"use client";
import { useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Label, inputClass } from "@/components/ui";
import type { Detail } from "./types";

export function Settings({ detail, reload }: { detail: Detail; reload: () => void }) {
  const s = detail.session;
  const [form, setForm] = useState({ title: s.title, description: s.description, video_title: s.video_title, video_url: s.video_url, salient_criteria: s.salient_criteria });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newQ, setNewQ] = useState("");
  const unlocked = !!s.part2_unlocked_at;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api("PATCH", `/api/facilitator/sessions/${s.id}`, form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }
  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <Banner tone="red" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}
      <Card title="Session details" actions={saved ? <Badge tone="green">✓ Saved</Badge> : undefined}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <Label htmlFor="t">Title</Label>
            <input id="t" className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="d" hint="Shown to participants at the top of their workspace">
              Description
            </Label>
            <textarea id="d" rows={2} className={inputClass} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="vt">Video title</Label>
            <input id="vt" className={inputClass} value={form.video_title} onChange={(e) => setForm({ ...form, video_title: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="vu" hint="Participants get a link that opens in a new tab. The video is not embedded.">
              Video link
            </Label>
            <input id="vu" className={inputClass} placeholder="https://" value={form.video_url} onChange={(e) => setForm({ ...form, video_url: e.target.value })} />
          </div>
        </div>
        <div className="mt-4">
          <Button onClick={save} loading={saving}>
            Save details
          </Button>
        </div>
      </Card>

      <Card title="Sharing settings" subtitle="Controls whether the original contributions you select on the Contributions tab are visible to participants.">
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" checked={s.sharing_enabled} onChange={(e) => act(() => api("PATCH", `/api/facilitator/sessions/${s.id}`, { sharing_enabled: e.target.checked }))} />
          <span>
            <strong>Show selected contributions to participants</strong>
            <br />
            <span className="text-slate-600">Switch off to hide everything you have shared, without un-selecting it.</span>
          </span>
        </label>
      </Card>

      <Card title="Guiding questions for Part 2" subtitle={unlocked ? "Part 2 is open. Editing wording is allowed (and logged); questions that groups have already answered cannot be deleted." : "Participants cannot see these until you unlock Part 2."}>
        <ol className="space-y-3">
          {detail.guiding_questions.map((q) => (
            <QuestionRow key={q.id} q={q} onSave={(text) => act(() => api("PATCH", `/api/facilitator/questions/${q.id}`, { text }))} onDelete={() => act(() => api("DELETE", `/api/facilitator/questions/${q.id}`))} />
          ))}
          {detail.guiding_questions.length === 0 && <li className="text-sm text-amber-800">No guiding questions yet. Part 2 cannot be unlocked without at least one.</li>}
        </ol>
        <div className="mt-4 flex gap-2">
          <input aria-label="New guiding question" className={inputClass} placeholder="Add a guiding question..." value={newQ} onChange={(e) => setNewQ(e.target.value)} />
          <Button
            onClick={() =>
              act(async () => {
                await api("POST", `/api/facilitator/sessions/${s.id}/questions`, { text: newQ });
                setNewQ("");
              })
            }
            disabled={!newQ.trim()}
          >
            Add
          </Button>
        </div>
      </Card>

      <Card title="Criteria for salient discussion points" subtitle="Used by the AI step that proposes points for whole-group discussion. Write what matters for this session; you can also change it each time you generate.">
        <textarea aria-label="Salient point criteria" rows={4} className={inputClass} value={form.salient_criteria} onChange={(e) => setForm({ ...form, salient_criteria: e.target.value })} />
        <div className="mt-3">
          <Button onClick={save} loading={saving}>
            Save criteria
          </Button>
        </div>
      </Card>
    </div>
  );
}

function QuestionRow({ q, onSave, onDelete }: { q: { id: string; position: number; text: string }; onSave: (t: string) => void; onDelete: () => void }) {
  const [text, setText] = useState(q.text);
  return (
    <li className="flex items-start gap-3">
      <span className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-semibold text-violet-800">{q.position}</span>
      <textarea aria-label={`Guiding question ${q.position}`} rows={2} className={inputClass} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text !== q.text && onSave(text)} />
      <Button variant="ghost" size="sm" onClick={() => window.confirm("Delete this question?") && onDelete()}>
        Delete
      </Button>
    </li>
  );
}
