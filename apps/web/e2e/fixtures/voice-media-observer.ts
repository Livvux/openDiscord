export type MediaEpoch = "initial" | "rekey";
export type ObservedGrant = { sources: string[]; publish: boolean; subscribe: boolean; data: boolean; expiresAtMs: number };
export type GrantObservation = {
  ordinal: number; status: number; settled: boolean; bodyRead: boolean; signatureVerified: boolean;
  errorStage: "pending" | "none" | "fetch" | "status" | "clone" | "body" | "verify" | "timeout";
  grant?: ObservedGrant;
};
export type GrantBinding = { identity: string; room: string; sources: string[] };
export function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }

export function assertDisposableVoiceCi(input: { ci?: string; githubActions?: string; apiKey?: string; apiSecret?: string; url?: string; authUrl?: string }): void {
  if (input.ci !== "true" || input.githubActions !== "true" || input.apiKey !== "devkey" || input.apiSecret !== "secret" || input.url !== "ws://localhost:7880" || input.authUrl !== "http://localhost:3000") throw new Error("Exact disposable loopback CI fixture required.");
}
export function assertVoiceBrowserOrigin(origin: string): void {
  if (origin !== "http://localhost:3200") throw new Error("Disposable loopback browser required.");
}

/** Test-only detached clone observation. The product receives the exact native response. */
export function createVoiceGrantObserver(nativeFetch: typeof fetch, origin: string, verify: (token: string, binding: GrantBinding) => Promise<ObservedGrant>, timeoutMs = 10_000) {
  const records: GrantObservation[] = [], pending = new Set<Promise<void>>();
  const observedFetch: typeof fetch = (input, init) => {
    let tokenRequest = false;
    if ((typeof input === "string" || input instanceof URL) && init?.method === "POST" && typeof init.body === "string") {
      try {
        const url = new URL(input, origin);
        if (url.origin === origin && url.pathname === "/api/voice/control") { const body: unknown = JSON.parse(init.body); tokenRequest = !!body && typeof body === "object" && "action" in body && body.action === "token"; }
      } catch { /* Native request stays untouched; strict request-count gates detect omissions. */ }
    }
    const record: GrantObservation | undefined = tokenRequest ? { ordinal: records.length + 1, status: 0, settled: false, bodyRead: false, signatureVerified: false, errorStage: "pending" } : undefined;
    if (record) records.push(record);
    return nativeFetch(input, init).then(response => {
      if (!record) return response;
      record.status = response.status;
      if (response.status !== 200) { record.settled = true; record.errorStage = "status"; return response; }
      let clone: Response;
      try { clone = response.clone(); } catch { record.settled = true; record.errorStage = "clone"; return response; }
      let settled = false;
      const timer = setTimeout(() => { settled = true; record.settled = true; record.errorStage = "timeout"; }, timeoutMs);
      record.errorStage = "body";
      const work = (async () => {
        const raw: unknown = await clone.json();
        if (!raw || typeof raw !== "object" || !("token" in raw) || typeof raw.token !== "string" || !("sources" in raw) || !strings(raw.sources) || !("participantIdentity" in raw) || typeof raw.participantIdentity !== "string" || !("roomName" in raw) || typeof raw.roomName !== "string") throw new Error("Invalid actual grant body.");
        if (settled) return;
        record.bodyRead = true; record.errorStage = "verify";
        const grant = await verify(raw.token, { identity: raw.participantIdentity, room: raw.roomName, sources: raw.sources });
        if (settled) return;
        // Copy only verified allowlisted fields; never retain raw body/JWT/identities.
        record.grant = { sources: [...grant.sources], publish: grant.publish, subscribe: grant.subscribe, data: grant.data, expiresAtMs: grant.expiresAtMs };
        record.signatureVerified = true; record.errorStage = "none";
      })().catch(() => { /* The fixed body/verify stage remains a hard failed result. */ }).finally(() => { clearTimeout(timer); settled = true; record.settled = true; });
      pending.add(work); void work.then(() => pending.delete(work));
      return response;
    }, error => { if (record) { record.settled = true; record.errorStage = "fetch"; } throw error; });
  };
  return {
    fetch: observedFetch,
    snapshot: () => records.map(record => ({ ...record, ...(record.grant ? { grant: { ...record.grant, sources: [...record.grant.sources] } } : {}) })),
    async settle(): Promise<void> {
      // Observation work is detached and bounded; never gate the original fetch.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all([...pending]), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
      finally { clearTimeout(timer); }
    },
  };
}

export function legitimateStartupConflict(input: {
  method: string; path: string; action: string; status: number; startup: boolean;
  expectedGeneration: number; currentGeneration: number;
}): boolean {
  return input.method === "POST" && input.path === "/api/voice/control" && input.action === "crypto" && input.status === 409 && input.startup
    && Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration > 0
    && Number.isSafeInteger(input.currentGeneration) && input.currentGeneration > input.expectedGeneration;
}
