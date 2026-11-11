"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/client/api";
import { Banner, Shell, Tabs } from "@/components/ui";
import { PageLoading, SignOut, useMe } from "@/components/useMe";
import { usePoll } from "@/components/usePoll";
import type { Dash, Detail } from "@/components/facilitator/types";
import { Overview } from "@/components/facilitator/Overview";
import { Contributions } from "@/components/facilitator/Contributions";
import { Roster } from "@/components/facilitator/Roster";
import { Settings } from "@/components/facilitator/Settings";
import { ExportTab } from "@/components/facilitator/ExportTab";
import { AiTab } from "@/components/facilitator/AiTab";

type TabId = "overview" | "contributions" | "ai" | "roster" | "settings" | "export";

export default function FacilitatorSession({ params }: { params: Promise<{ sid: string }> }) {
  const { sid } = use(params);
  const me = useMe();
  const [tab, setTab] = useState<TabId>("overview");
  const [groupId, setGroupId] = useState<string>("");
  const dash = usePoll<Dash>(() => api<Dash>("GET", `/api/facilitator/sessions/${sid}/dashboard`), 10000, [sid]);
  const detail = usePoll<Detail>(() => api<Detail>("GET", `/api/facilitator/sessions/${sid}`), 60000, [sid]);
  const reloadAll = useCallback(() => {
    void dash.reload();
    void detail.reload();
  }, [dash, detail]);

  useEffect(() => {
    if (!groupId && dash.data?.groups[0]) setGroupId(dash.data.groups[0].id);
  }, [dash.data, groupId]);

  if (!me || (dash.loading && !dash.data)) return <PageLoading />;
  if (!dash.data) {
    return (
      <Shell right={<SignOut />}>
        <Banner tone="red">{dash.error ? errorMessage(dash.error) : "Could not open this session"}</Banner>
        <p className="mt-4">
          <Link href="/facilitator" className="text-blue-700 underline">
            Back to your sessions
          </Link>
        </p>
      </Shell>
    );
  }
  const d = dash.data;
  return (
    <Shell title={d.session.title} right={<><span className="text-blue-100">{me.name}</span><SignOut /></>}>
      <div className="space-y-6">
        <div>
          <Link href="/facilitator" className="text-sm text-blue-700 hover:underline">
            &larr; All sessions
          </Link>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">{d.session.title}</h1>
        </div>
        {dash.error && <Banner tone="amber">Connection problem: the numbers below may be out of date. {errorMessage(dash.error)}</Banner>}
        <Tabs<TabId>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "contributions", label: "Contributions" },
            { id: "ai", label: "AI analysis" },
            { id: "roster", label: "Groups & people" },
            { id: "settings", label: "Questions & settings" },
            { id: "export", label: "Export" },
          ]}
        />
        {tab === "overview" && (
          <Overview
            dash={d}
            detail={detail.data}
            reload={reloadAll}
            openGroup={(g) => {
              setGroupId(g);
              setTab("contributions");
            }}
          />
        )}
        {tab === "contributions" && groupId && <Contributions dash={d} detail={detail.data} groupId={groupId} setGroupId={setGroupId} reloadDash={() => void dash.reload()} />}
        {tab === "ai" && <AiTab dash={d} detail={detail.data} reloadDash={() => void dash.reload()} />}
        {tab === "roster" && (detail.data ? <Roster detail={detail.data} reload={reloadAll} /> : <p className="text-sm text-slate-500">Loading...</p>)}
        {tab === "settings" && (detail.data ? <Settings key={JSON.stringify([detail.data.session.sharing_enabled])} detail={detail.data} reload={reloadAll} /> : <p className="text-sm text-slate-500">Loading...</p>)}
        {tab === "export" && <ExportTab sid={sid} />}
      </div>
    </Shell>
  );
}
