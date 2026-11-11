"use client";
import { useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Label, inputClass } from "@/components/ui";
import type { Detail } from "./types";

interface AddResult {
  email: string;
  name?: string;
  status: "created" | "existing" | "error";
  temp_password?: string;
  error?: string;
}

export function Roster({ detail, reload }: { detail: Detail; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AddResult[] | null>(null);
  const [newGroup, setNewGroup] = useState("");

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">
        Participants can only pick a group you have authorised them for, and only after they join with the session code. Removing someone from a group ends their access immediately; entries they already wrote stay with the group.
      </p>
      {error && (
        <Banner tone="red" onClose={() => setError(null)}>
          {error}
        </Banner>
      )}
      {results && (
        <Banner tone="amber" onClose={() => setResults(null)}>
          <p className="font-medium">People added. Temporary passwords are shown only now, so copy them and pass them on privately. Teachers must change them at first sign-in.</p>
          <ul className="mt-2 space-y-1">
            {results.map((r, i) => (
              <li key={i} className="font-mono text-xs">
                {r.email}: {r.status === "created" ? <strong>{r.temp_password}</strong> : r.status === "existing" ? "already has an account (password unchanged)" : <span className="text-red-700">{r.error}</span>}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            onClick={() => navigator.clipboard?.writeText(results.filter((r) => r.status === "created").map((r) => `${r.email}\t${r.temp_password}`).join("\n"))}
          >
            Copy as a list
          </Button>
        </Banner>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        {detail.groups.map((g) => (
          <GroupCard key={g.id} group={g} sid={detail.session.id} onError={setError} onAdded={(r) => { setResults(r); reload(); }} run={run} />
        ))}
      </div>
      <Card title="Add a group">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[14rem] flex-1">
            <Label htmlFor="ng">Group name (optional)</Label>
            <input id="ng" className={inputClass} value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="Group 4" />
          </div>
          <Button
            onClick={() =>
              run(async () => {
                await api("POST", `/api/facilitator/sessions/${detail.session.id}/groups`, { name: newGroup });
                setNewGroup("");
              })
            }
          >
            Add group
          </Button>
        </div>
      </Card>
    </div>
  );
}

function GroupCard({ group, sid, onAdded, onError, run }: { group: Detail["groups"][number]; sid: string; onAdded: (r: AddResult[]) => void; onError: (m: string) => void; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [name, setName] = useState(group.name);
  const [people, setPeople] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const lines = people.split("\n").map((l) => l.trim()).filter(Boolean);
    const parsed = lines.map((l) => {
      const m = /^(.*?)[,;\t]\s*([^\s,;]+@[^\s,;]+)\s*$/.exec(l) ?? /^([^<]*)<([^>]+)>$/.exec(l);
      return m ? { name: m[1].trim() || m[2].split("@")[0], email: m[2].trim() } : { name: l, email: l };
    });
    if (parsed.length === 0) return;
    setBusy(true);
    try {
      const r = await api<{ results: AddResult[] }>("POST", `/api/facilitator/sessions/${sid}/participants`, { people: parsed, group_id: group.id });
      onAdded(r.results);
      setPeople("");
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label={`Name of ${group.code}`} className={`${inputClass} max-w-[14rem] font-medium`} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== group.name && name.trim() && run(() => api("PATCH", `/api/facilitator/groups/${group.id}`, { name }))} />
        <Badge tone={group.active ? "green" : "gray"}>{group.active ? "Active" : "Inactive"}</Badge>
        <Button size="sm" variant="ghost" onClick={() => run(() => api("PATCH", `/api/facilitator/groups/${group.id}`, { active: !group.active }))}>
          {group.active ? "Mark inactive" : "Mark active"}
        </Button>
      </div>
      <ul className="mt-4 divide-y divide-slate-100">
        {group.people.length === 0 && <li className="py-2 text-sm text-slate-500">Nobody authorised yet.</li>}
        {group.people.map((p) => (
          <li key={p.user_id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div>
              <p className="font-medium text-slate-900">{p.name}</p>
              <p className="text-xs text-slate-500">{p.email}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={p.selected ? "green" : p.joined ? "blue" : "gray"}>{p.selected ? "In group" : p.joined ? "Joined session" : "Not joined"}</Badge>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (window.confirm(`Remove ${p.name} from ${group.name}? They lose access to this group immediately.`)) void run(() => api("DELETE", `/api/facilitator/groups/${group.id}/authorise/${p.user_id}`));
                }}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 border-t border-slate-100 pt-4">
        <Label htmlFor={`add-${group.id}`} hint="One person per line: Name, email. New accounts get a temporary password.">
          Add people to this group
        </Label>
        <textarea id={`add-${group.id}`} rows={3} className={inputClass} placeholder={"Alex Teacher, alex@school.org"} value={people} onChange={(e) => setPeople(e.target.value)} />
        <Button className="mt-2" size="sm" onClick={add} loading={busy} disabled={!people.trim()}>
          Add and authorise
        </Button>
      </div>
    </Card>
  );
}
