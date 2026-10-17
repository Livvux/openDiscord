"use client";
import { useState } from "react";

/** Isolated CI fixture. No production call, account state or server secret enters this module. */
export function ThreeBrowserProof() {
  const [status, setStatus] = useState("Load three browser proof");
  async function load() {
    try {
      const fixture = await import("../../../../e2e/fixtures/voice-three-browser");
      fixture.configureWorker(new URL("livekit-client/e2ee-worker", import.meta.url));
      setStatus("Three browser proof ready");
    } catch { setStatus("Three browser proof failed"); }
  }
  return <button type="button" onClick={() => void load()} disabled={status !== "Load three browser proof"}>{status}</button>;
}
