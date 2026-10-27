"use client";

import Link from "next/link";
import { resolvePrivateReport } from "@/app/app/admin/actions";
import type { listDirectReports } from "@/server/direct-messages";
import { QuickAction } from "./admin-action";
import { adminHref, EmptyState, formatDate } from "./shared";

export function PrivateReports({ reports }: { reports: Awaited<ReturnType<typeof listDirectReports>> }) {
  if (!reports.length) return <EmptyState>No open private message reports.</EmptyState>;
  return (
    <ul className="divide-y">
      {reports.map((report) => (
        <li key={report.id} className="space-y-3 py-4">
          <div>
            <p className="font-medium text-zinc-100">Private message report · {report.senderName}</p>
            <p className="text-xs text-muted-foreground">{formatDate(report.createdAt)}</p>
          </div>
          <p className="break-words whitespace-pre-wrap">{report.reason}</p>
          {report.excerpt === null
            ? <p className="text-sm text-muted-foreground">No message text was disclosed.</p>
            : <blockquote className="border-l-2 pl-3 break-words whitespace-pre-wrap">{report.excerpt}</blockquote>}
          <div className="flex flex-wrap items-center gap-2">
            <QuickAction label="Mark reviewed" variant="outline" action={() => resolvePrivateReport(report.id)} />
            <Link href={adminHref({ tab: "users", q: report.senderName })} className="text-sm text-muted-foreground underline hover:text-zinc-100">Open sender in Users</Link>
          </div>
        </li>
      ))}
    </ul>
  );
}
