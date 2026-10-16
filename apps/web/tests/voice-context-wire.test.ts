import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_LIMITS, voiceCryptoSchema } from "../src/lib/voice/contracts";
import { voiceControlParty, voiceOwnerControlSchema, VOICE_CONTROL_EVENT } from "../src/lib/voice/owner-control";
import { contextWireFixture } from "./fixtures/voice-context-wire";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("S6-A1 eight-party encrypted wire feasibility, no eight-browser/media claim", () => {
  for (const maximumIds of [false, true]) for (const kind of ["context-offer", "context-accept", "context-restart", "material"] as const) it(`measures ${maximumIds ? "max128-ASCII" : "generated UUID"} IDs in the entire native ${kind} VoiceCryptoRequest against the unchanged 8192-byte service ceiling`, async () => {
    const measurements: number[] = [];
    const fixture = await contextWireFixture(async ({ request }) => {
      if (request.kind === "send" && request.eventType === "m.room.encrypted") {
        const bytes = Buffer.byteLength(JSON.stringify(voiceCryptoSchema.parse(request)), "utf8");
        measurements.push(bytes);
        expect(bytes, `${kind} complete encrypted request bytes`).toBeLessThanOrEqual(VOICE_LIMITS.requestBytes);
      }
      return undefined;
    }, maximumIds, kind === "context-offer");
    try {
      const audience = fixture.snapshot.members.map(voiceControlParty), sender = voiceControlParty(fixture.remote), recipient = voiceControlParty(fixture.own);
      const reference = randomUUID();
      const common = { version: 1, purpose: VOICE_CONTROL_EVENT, callId: fixture.snapshot.callId, generation: 1, epochId: randomUUID(), sender, recipient, audience, reference, transaction: reference };
      const payload = kind === "material"
        ? voiceOwnerControlSchema.parse({ ...common, kind, publisher: sender, keyId: randomUUID(), material: Buffer.alloc(32, 9).toString("base64") })
        : { ...common, kind, leader: audience[0], sequence: 1 };
      await fixture.peer.encrypt(fixture.own, payload);
      expect(measurements).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 30_000);
});
