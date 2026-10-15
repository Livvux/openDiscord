import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { describe, expect, it } from "vitest";
import { EphemeralVoice, verifyPair } from "./fixtures/ephemeral-voice";
import { GenerationServer, GenerationDispatcher, identity } from "./fixtures/voice-generation";

describe("isolated native generation retirement candidate", () => {
  for (const phase of ["request", "ready", "start", "key", "mac", "done"]) {
    for (const removed of [false, true]) {
      it(`retires pending ${phase} to a ${removed ? "departed" : "current"} peer and verifies a fresh surviving peer`, async () => {
        await C.initAsync();
        const server = new GenerationServer();
        const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server), c = await EphemeralVoice.open(server);
        const dispatchers = [a, b, c].map((owner) => new GenerationDispatcher(owner, server));
        const before = identity(a);
        try {
          await verifyPair(a, c);
          const [left, right] = dispatchers;
          const paused = Promise.race([left.pauseAt(phase), right.pauseAt(phase)]);
          const oldFlow = verifyPair(a, b).then(() => "completed", () => "interrupted");
          const pending = await paused;
          expect(pending.request.event_type).toBe(`m.key.verification.${phase}`);
          const immutable = { id: pending.request.id, type: pending.request.type, body: pending.request.body };
          if (removed) server.remove(b);
          server.advance();
          for (const dispatcher of dispatchers) await dispatcher.cancelAndRetire();
          expect(await oldFlow).toBe("interrupted");
          expect({ id: pending.request.id, type: pending.request.type, body: pending.request.body }).toEqual(immutable);
          expect(server.retired.length).toBeGreaterThan(0);
          expect(server.retired.every((receipt) => receipt.enqueued === 0 && receipt.disposition === "processed-retired")).toBe(true);
          expect(identity(a)).toEqual(before);
          expect((await a.device(c)).isVerified()).toBe(true);
          for (const owner of [a, c]) expect((await owner.machine.outgoingRequests()).filter((r) => r.type === C.RequestType.ToDevice)).toHaveLength(0);
          await verifyPair(a, removed ? c : b);
          const peer = removed ? c : b;
          await a.admit(peer); await peer.admit(a);
          expect(peer.received).toHaveLength(0);
          await a.send(peer, "Fresh genuine peer receipt");
          expect(peer.received).toHaveLength(0);
          await peer.sync();
          expect(peer.received).toHaveLength(1);
          expect(identity(a)).toEqual(before);
          expect(dispatchers.every((d) => [...d.completions.values()].every((count) => count === 1))).toBe(true);
        } finally { dispatchers.forEach((d) => d.release()); [a, b, c].forEach((owner) => owner.close()); }
      }, 30_000);
    }
  }
});
