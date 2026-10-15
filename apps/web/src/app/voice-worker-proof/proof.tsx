"use client";

import { useState } from "react";

/** CI-only production-bundler probe. No server credentials or product voice state enter this module. */
export function VoiceWorkerProof() {
  const [status, setStatus] = useState("Load native worker proof");
  async function load() {
    try {
      const fixture = await import("../../../e2e/fixtures/voice-worker");
      fixture.configureWorkerUrl(new URL("livekit-client/e2ee-worker", import.meta.url));
      setStatus("Native worker proof ready");
    } catch {
      setStatus("Native worker proof failed to load");
    }
  }
  return <button type="button" onClick={() => void load()} disabled={status !== "Load native worker proof"}>{status}</button>;
}
