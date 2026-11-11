"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Label, Shell, inputClass } from "@/components/ui";
import { PageLoading, SignOut, useMe } from "@/components/useMe";

interface MySession {
  id: string;
  title: string;
  description: string;
  part2_unlocked: boolean;
  group: { id: string; code: string; name: string } | null;
}

export default function Home() {
  const me = useMe();
  const [sessions, setSessions] = useState<MySession[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (me?.role === "facilitator") window.location.replace("/facilitator");
    if (me?.role === "participant") {
      api<{ sessions: MySession[] }>("GET", "/api/my/sessions")
        .then((r) => setSessions(r.sessions))
        .catch((e) => setLoadError(errorMessage(e)));
    }
  }, [me]);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ session_id: string }>("POST", "/api/sessions/join", { code });
      window.location.href = `/s/${r.session_id}`;
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (!me || me.role === "facilitator") return <PageLoading />;
  return (
    <Shell
      right={
        <>
          <span className="text-blue-100">{me.name}</span>
          <SignOut />
        </>
      }
    >
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Welcome, {me.name.split(" ")[0]}</h1>
          <p className="mt-1 text-slate-600">Join a PD session with the code from your facilitator, or continue where you left off.</p>
        </div>
        <Card title="Join a session">
          <form onSubmit={join} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[12rem] flex-1">
              <Label htmlFor="code">Join code</Label>
              <input id="code" className={`${inputClass} font-mono uppercase tracking-widest`} maxLength={12} placeholder="e.g. DEMO42" value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
            <Button type="submit" loading={busy}>
              Join session
            </Button>
          </form>
          {error && (
            <div className="mt-3">
              <Banner tone="red">{error}</Banner>
            </div>
          )}
        </Card>
        <Card title="Your sessions">
          {loadError && <Banner tone="red">{loadError}</Banner>}
          {!sessions && !loadError && <p className="text-sm text-slate-500">Loading...</p>}
          {sessions && sessions.length === 0 && <p className="text-sm text-slate-600">You have not joined a session yet.</p>}
          <ul className="divide-y divide-slate-100">
            {sessions?.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium text-slate-900">{s.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-slate-600">
                    {s.group ? <Badge tone="blue">{s.group.name}</Badge> : <Badge tone="amber">Choose your group</Badge>}
                    {s.part2_unlocked && <Badge tone="purple">Part 2 open</Badge>}
                  </p>
                </div>
                <Link href={`/s/${s.id}`} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">
                  Open
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </Shell>
  );
}
