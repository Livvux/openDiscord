"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

interface SessionRow {
  id: string;
  token: string;
  userAgent?: string | null;
  createdAt: Date;
}

function describe(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = /Firefox\//.test(userAgent) ? "Firefox" : /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /Windows/.test(userAgent) ? "Windows" : /Android/.test(userAgent) ? "Android" : /iPhone|iPad/.test(userAgent) ? "iOS" : /Mac OS X/.test(userAgent) ? "macOS" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export function Sessions() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, me] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    if (list.error) return setError(list.error.message ?? "Could not load sessions.");
    setSessions(list.data);
    setCurrent(me.data?.session.token ?? null);
  }, []);

  useEffect(() => {
    // Initial fetch from an external system (the auth API).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function revoke(token: string) {
    const { error } = await authClient.revokeSession({ token });
    if (error) setError(error.message ?? "Could not sign out that device.");
    else void load();
  }

  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!sessions) return <p className="text-sm text-muted-foreground">Loading sessions…</p>;
  return (
    <ul className="divide-y rounded-lg border">
      {sessions.map((s) => (
        <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <span>
            {describe(s.userAgent)}
            <span className="block text-xs text-muted-foreground" suppressHydrationWarning>
              Signed in {new Date(s.createdAt).toLocaleString()}
            </span>
          </span>
          {s.token === current ? (
            <span className="text-xs text-muted-foreground">This device</span>
          ) : (
            <Button variant="outline" size="sm" onClick={() => revoke(s.token)}>Sign out</Button>
          )}
        </li>
      ))}
    </ul>
  );
}
