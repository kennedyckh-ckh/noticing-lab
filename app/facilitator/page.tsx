"use client";
import Link from "next/link";
import { useState } from "react";
import { api, errorMessage, fmtDate } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Label, Shell, inputClass } from "@/components/ui";
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
}

export default function FacilitatorHome() {
  const me = useMe();
  const list = usePoll<{ sessions: Row[] }>(() => api<{ sessions: Row[] }>("GET", "/api/facilitator/sessions"), 30000);
  const [form, setForm] = useState({ title: "", description: "", video_title: "", video_url: "", num_groups: 3 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <Card>
          {list.error && !list.data && <Banner tone="red">{errorMessage(list.error)}</Banner>}
          {list.data && list.data.sessions.length === 0 && <p className="text-sm text-slate-600">No sessions yet. Create your first one below.</p>}
          <ul className="divide-y divide-slate-100">
            {list.data?.sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium text-slate-900">{s.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                    <Badge tone="purple">Code {s.join_code}</Badge>
                    <span>{s.active_groups} active groups</span>
                    <span>&middot; {s.joined} joined</span>
                    {s.part2_unlocked_at && <Badge tone="green">Part 2 open</Badge>}
                    <span className="text-slate-400">created {fmtDate(s.created_at)}</span>
                  </p>
                </div>
                <Link href={`/facilitator/${s.id}`} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">
                  Open dashboard
                </Link>
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
    </Shell>
  );
}
