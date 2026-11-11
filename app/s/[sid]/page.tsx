"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { Badge, Banner, Button, Card, Shell, Tabs } from "@/components/ui";
import { PageLoading, SignOut, useMe } from "@/components/useMe";
import { usePoll } from "@/components/usePoll";
import { PartPanel, StatusBadge, usePartSaveState, type Workspace } from "@/components/participant/PartPanel";
import { SaveBadge } from "@/components/participant/EntryCard";
import { SharedPanel } from "@/components/participant/SharedPanel";

interface Overview {
  session: { id: string; title: string; description: string; video_title: string; video_url: string; part2_unlocked: boolean };
  authorised_groups: Array<{ id: string; code: string; name: string; active: boolean; member_count: number }>;
  selected_group_id: string | null;
}

type TabId = "p1" | "p2" | "shared";

export default function SessionPage({ params }: { params: Promise<{ sid: string }> }) {
  const { sid } = use(params);
  const me = useMe();
  const overview = usePoll<Overview>(() => api<Overview>("GET", `/api/sessions/${sid}/overview`), 60000, [sid]);

  if (!me || (overview.loading && !overview.data)) return <PageLoading />;
  if (!overview.data) {
    return (
      <Shell right={<SignOut />}>
        <Banner tone="red">{overview.error ? errorMessage(overview.error) : "Could not open this session"}</Banner>
        <p className="mt-4">
          <Link href="/" className="text-blue-700 underline">
            Back to your sessions
          </Link>
        </p>
      </Shell>
    );
  }
  if (!overview.data.selected_group_id) return <GroupPicker sid={sid} ov={overview.data} onChosen={overview.reload} me={me.name} />;
  return <Workspace sid={sid} groupId={overview.data.selected_group_id} meName={me.name} />;
}

function GroupPicker({ sid, ov, onChosen, me }: { sid: string; ov: Overview; onChosen: () => void; me: string }) {
  const [choice, setChoice] = useState<string>(ov.authorised_groups.length === 1 ? ov.authorised_groups[0].id : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/sessions/${sid}/group`, { group_id: choice });
      onChosen();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Shell right={<><span className="text-blue-100">{me}</span><SignOut /></>} title={ov.session.title}>
      <div className="mx-auto max-w-xl space-y-5">
        <Card title="Choose your group" subtitle="These are the groups your facilitator has authorised you for. You will write and submit with this group.">
          <div role="radiogroup" className="space-y-2">
            {ov.authorised_groups.map((g) => (
              <label key={g.id} className={`flex cursor-pointer items-center justify-between rounded-xl border p-4 ${choice === g.id ? "border-violet-600 bg-violet-50" : "border-slate-200 hover:bg-slate-50"} ${g.active ? "" : "opacity-50"}`}>
                <span className="flex items-center gap-3">
                  <input type="radio" name="group" value={g.id} disabled={!g.active} checked={choice === g.id} onChange={() => setChoice(g.id)} />
                  <span className="font-medium text-slate-900">{g.name}</span>
                </span>
                <span className="text-sm text-slate-500">{g.active ? `${g.member_count} joined` : "not active"}</span>
              </label>
            ))}
            {ov.authorised_groups.length === 0 && <p className="text-sm text-slate-600">You are not authorised for any group in this session. Please ask your facilitator.</p>}
          </div>
          {error && (
            <div className="mt-3">
              <Banner tone="red">{error}</Banner>
            </div>
          )}
          <div className="mt-5">
            <Button onClick={go} disabled={!choice} loading={busy}>
              Join this group
            </Button>
          </div>
        </Card>
      </div>
    </Shell>
  );
}

function Workspace({ sid, groupId, meName }: { sid: string; groupId: string; meName: string }) {
  const [tab, setTab] = useState<TabId>("p1");
  const [sharedCount, setSharedCount] = useState(0);
  const [part2Notice, setPart2Notice] = useState(false);
  const save = usePartSaveState();
  const ws = usePoll<Workspace>(() => api<Workspace>("GET", `/api/groups/${groupId}/workspace`), 8000, [groupId]);
  const prevLocked = useRef<boolean | null>(null);

  const reload = useCallback(() => ws.reload(), [ws]);

  // tell the participant when the facilitator opens Part 2
  const locked2 = ws.data?.part2.locked;
  useEffect(() => {
    if (locked2 === undefined) return;
    if (prevLocked.current === true && locked2 === false) setPart2Notice(true);
    prevLocked.current = locked2;
  }, [locked2]);

  // protect against closing the tab with unsaved work; flush when the tab is hidden
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (save.hasUnsaved) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const hide = () => document.visibilityState === "hidden" && void save.flushAll();
    window.addEventListener("beforeunload", warn);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [save]);

  if (ws.loading && !ws.data) return <PageLoading label="Opening your workspace" />;
  if (!ws.data) {
    return (
      <Shell right={<SignOut />}>
        <Banner tone="red" action={<Button size="sm" variant="secondary" onClick={() => void ws.reload()}>Try again</Button>}>
          {ws.error ? errorMessage(ws.error) : "Could not load your workspace"}
        </Banner>
      </Shell>
    );
  }
  const w = ws.data;
  return (
    <Shell
      title={w.session.title}
      right={
        <>
          <SaveBadge state={save.worst} onRetry={() => void save.flushAll()} />
          <span className="hidden text-blue-100 sm:inline">{meName}</span>
          <SignOut />
        </>
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link
              href="/"
              onClick={(e) => {
                if (save.hasUnsaved && !window.confirm("You have changes that are not saved yet. Leave anyway?")) e.preventDefault();
              }}
              className="text-sm text-blue-700 hover:underline"
            >
              &larr; All sessions
            </Link>
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">{w.session.title}</h1>
            {w.session.description && <p className="mt-1 max-w-2xl text-slate-600">{w.session.description}</p>}
            {w.session.video_title && (
              <p className="mt-2 text-sm text-slate-700">
                Video: <strong>{w.session.video_title}</strong>{" "}
                {w.session.video_url && (
                  <a href={w.session.video_url} target="_blank" rel="noopener noreferrer" className="text-blue-700 underline">
                    open the video in a new tab
                  </a>
                )}
              </p>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <p className="font-semibold text-slate-900">{w.group.name}</p>
            <p className="mt-1 text-slate-600">{w.members.map((m) => (m.id === w.me.id ? `${m.name} (you)` : m.name)).join(", ")}</p>
          </div>
        </div>

        {ws.error && <Banner tone="amber">We lost the connection. Whatever you type is kept on this device and we keep retrying to save it. {errorMessage(ws.error)}</Banner>}
        {part2Notice && (
          <Banner
            tone="purple"
            onClose={() => setPart2Notice(false)}
            action={
              <Button
                size="sm"
                variant="accent"
                onClick={() => {
                  setTab("p2");
                  setPart2Notice(false);
                }}
              >
                Go to Part 2
              </Button>
            }
          >
            Your facilitator has opened <strong>Part 2: Guided noticing</strong>.
          </Banner>
        )}

        <Tabs<TabId>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "p1", label: <span className="flex items-center gap-2">Part 1: Initial noticing <StatusBadge data={w.part1} /></span> },
            { id: "p2", label: <span className="flex items-center gap-2">Part 2: Guided noticing <StatusBadge data={w.part2} /></span> },
            { id: "shared", label: <span className="flex items-center gap-2">Shared with everyone {sharedCount > 0 && <Badge tone="purple">{sharedCount}</Badge>}</span> },
          ]}
        />

        <div hidden={tab !== "p1"}>
          <PartPanel part={1} ws={w} data={w.part1} reload={reload} save={save} />
        </div>
        <div hidden={tab !== "p2"}>
          <PartPanel part={2} ws={w} data={w.part2} reload={reload} save={save} />
        </div>
        <div hidden={tab !== "shared"}>
          <SharedPanel sessionId={sid} onCount={setSharedCount} />
        </div>
      </div>
    </Shell>
  );
}
