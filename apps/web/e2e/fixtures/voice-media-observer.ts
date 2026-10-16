export type MediaEpoch = "initial" | "rekey";
export type ObservedGrant = { sources: string[]; publish: boolean; subscribe: boolean; data: boolean };
export type GrantObservation = {
  epoch: MediaEpoch; pageIndex: number; status: number; finished: boolean;
  requestFailure: "none" | "aborted" | "network";
  errorStage: "none" | "status" | "finished" | "body" | "verify" | "timeout";
  grant?: ObservedGrant;
};

/** Always fulfills immediately-handled results; raw errors/JWTs never enter the ledger. */
export function observeMediaGrant(input: {
  epoch: MediaEpoch; pageIndex: number; status: number;
  finished(): Promise<Error | null>;
  failure(): { errorText: string } | null;
  read(): Promise<{ token: string; sources: string[] }>;
  verify(token: string): Promise<{ publish: boolean; subscribe: boolean; data: boolean }>;
}, timeoutMs = 10_000): Promise<GrantObservation> {
  const result: GrantObservation = { epoch: input.epoch, pageIndex: input.pageIndex, status: input.status, finished: false, requestFailure: "none", errorStage: "finished" };
  const work = (async (): Promise<GrantObservation> => {
    try {
      const error = await input.finished();
      const failure = input.failure();
      result.finished = error === null && failure === null;
      result.requestFailure = failure ? failure.errorText === "net::ERR_ABORTED" ? "aborted" : "network" : "none";
      if (!result.finished) return { ...result };
      if (input.status !== 200) return { ...result, errorStage: "status" };
      result.errorStage = "body";
      const grant = await input.read();
      result.errorStage = "verify";
      const claims = await input.verify(grant.token);
      return { ...result, errorStage: "none", grant: { sources: [...grant.sources], ...claims } };
    } catch {
      const failure = input.failure();
      if (failure) { result.finished = false; result.requestFailure = failure.errorText === "net::ERR_ABORTED" ? "aborted" : "network"; }
      return { ...result };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<GrantObservation>(resolve => { timer = setTimeout(() => resolve({ ...result, errorStage: "timeout" }), timeoutMs); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function legitimateStartupConflict(input: {
  method: string; path: string; action: string; status: number; startup: boolean;
  expectedGeneration: number; currentGeneration: number;
}): boolean {
  return input.method === "POST" && input.path === "/api/voice/control" && input.action === "crypto" && input.status === 409 && input.startup
    && Number.isSafeInteger(input.expectedGeneration) && input.expectedGeneration > 0
    && Number.isSafeInteger(input.currentGeneration) && input.currentGeneration > input.expectedGeneration;
}
