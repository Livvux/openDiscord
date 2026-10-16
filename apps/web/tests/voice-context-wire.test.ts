import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_LIMITS, voiceCryptoSchema } from "../src/lib/voice/contracts";
import { voiceControlParty, voiceOwnerControlSchema, VOICE_CONTROL_EVENT } from "../src/lib/voice/owner-control";
import { contextWireFixture } from "./fixtures/voice-context-wire";
import { decodeVoiceControlWire, encodeVoiceControlWire } from "../src/lib/voice/control-wire";
import { validateVoiceContextControl, voiceContextControlSchema } from "../src/lib/voice/context-control";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("S6-A1 eight-party encrypted wire feasibility, no eight-browser/media claim", () => {
  for (const idKind of ["uuid", "max-ascii", "max-utf8"] as const) for (const kind of ["context-offer", "context-accept", "context-restart", "material"] as const) it(`measures ${idKind} IDs in the entire native ${kind} VoiceCryptoRequest against the unchanged 8192-byte service ceiling`, async () => {
    const measurements: number[] = [];
    const fixture = await contextWireFixture(async ({ request }) => {
      if (request.kind === "send" && request.eventType === "m.room.encrypted") {
        const bytes = Buffer.byteLength(JSON.stringify(voiceCryptoSchema.parse(request)), "utf8");
        measurements.push(bytes);
        console.info(`voice-wire-feasibility ${idKind} ${kind}: ${bytes} bytes`);
        expect(bytes, `${kind} complete encrypted request bytes`).toBeLessThanOrEqual(VOICE_LIMITS.requestBytes);
      }
      return undefined;
    }, idKind, kind === "context-offer");
    try {
      const audience = fixture.snapshot.members.map(voiceControlParty), sender = voiceControlParty(fixture.remote), recipient = voiceControlParty(fixture.own);
      const reference = randomUUID();
      const common = { version: 1, purpose: VOICE_CONTROL_EVENT, callId: fixture.snapshot.callId, generation: 1, epochId: randomUUID(), sender, recipient, audience, reference, transaction: reference };
      const payload = kind === "material"
        ? voiceOwnerControlSchema.parse({ ...common, kind, publisher: sender, keyId: randomUUID(), material: Buffer.alloc(32, 9).toString("base64") })
        : voiceContextControlSchema.parse({ ...common, kind, leader: audience[0], sequence: 1 });
      if (payload.kind !== "material") expect(validateVoiceContextControl(payload, fixture.snapshot, audience)).toEqual(payload);
      const encoded = encodeVoiceControlWire(payload);
      expect(decodeVoiceControlWire(encoded)).toEqual(payload);
      await fixture.peer.encrypt(fixture.own, encoded);
      expect(measurements).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 30_000);
});
