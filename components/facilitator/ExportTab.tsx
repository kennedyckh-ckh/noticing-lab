"use client";
import { Card } from "@/components/ui";

export function ExportTab({ sid }: { sid: string }) {
  const link = (format: string, what: string, label: string, hint: string) => (
    <a href={`/api/facilitator/sessions/${sid}/export?format=${format}&what=${what}`} className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 p-4 hover:bg-slate-50" download>
      <span>
        <span className="block font-medium text-slate-900">{label}</span>
        <span className="block text-sm text-slate-600">{hint}</span>
      </span>
      <span className="rounded-lg bg-blue-700 px-3 py-1.5 text-sm font-medium text-white">Download</span>
    </a>
  );
  return (
    <div className="space-y-5">
      <Card title="Export" subtitle="Everything is exported exactly as stored: original wording, stage labels, timestamps and contributors. Join codes and passwords are never included.">
        <div className="space-y-3">
          {link("json", "all", "Complete session (JSON)", "Responses, Part 1 and Part 2 labels, created/updated/submitted times, guiding questions, submission snapshots, overrides, sharing flags and all AI outputs (generated, edited and published versions).")}
          {link("csv", "entries", "Participant responses (CSV)", "One row per entry with entry ID, stage label, group, contributor, video timestamp, status and times. Opens in Excel or Sheets.")}
          {link("csv", "questions", "Guiding questions (CSV)", "The facilitator-defined questions in order.")}
          {link("csv", "ai", "AI outputs (CSV)", "Every AI draft with provider, whether it was simulated, criteria used, cited source IDs, edits and publication state.")}
        </div>
      </Card>
      <p className="text-xs text-slate-500">Exports contain participants&apos; names and email addresses. Store and share them according to your data-protection rules.</p>
    </div>
  );
}
