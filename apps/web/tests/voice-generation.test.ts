import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EphemeralVoice, verifyPair } from "./fixtures/ephemeral-voice";
import { GenerationServer, GenerationDispatcher, encryptGenerationControl, identity, receiveGenerationControls, validateGenerationToDevice } from "./fixtures/voice-generation";

describe("isolated native generation retirement candidate", () => {
  it("processes genuine mixed current/departed native queries and claims without rewriting their bodies", async () => {
    await C.initAsync();
    const server = new GenerationServer();
    const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server), c = await EphemeralVoice.open(server), d = await EphemeralVoice.open(server);
    const dispatcher = new GenerationDispatcher(a, server);
    try {
      await verifyPair(a, d); await a.query([a, b, c]);
      const query = a.machine.queryKeysForUsers([new C.UserId(b.binding.user), new C.UserId(c.binding.user)]);
      const claim = await a.machine.getMissingSessions([new C.UserId(b.binding.user), new C.UserId(c.binding.user)]);
      if (!claim) throw new Error("Expected genuine mixed native claim.");
      expect(Object.keys(JSON.parse(query.body).device_keys)).toHaveLength(2);
      expect(Object.keys(JSON.parse(claim.body).one_time_keys)).toHaveLength(2);
      const queryBody = query.body, claimBody = claim.body;
      const currentBefore = server.take(c).count;
      server.remove(b); server.advance();
      const claimId = randomUUID();
      const claimResponse = await server.process(a, claim, server.generation, "send", claimId);
      expect(Object.keys(claimResponse.nativeResponse.one_time_keys as object)).toEqual([c.binding.user]);
      expect(server.take(c).count).toBe(currentBefore - 1);
      expect(await server.process(a, claim, server.generation, "send", claimId)).toBe(claimResponse);
      expect(server.take(c).count).toBe(currentBefore - 1);
      await dispatcher.acceptResponse(claim, claimResponse);
      const queryResponse = await server.process(a, query, server.generation, "send", randomUUID());
      const deviceKeys = queryResponse.nativeResponse.device_keys as Record<string, object>;
      expect(Object.keys(deviceKeys[b.binding.user])).toHaveLength(0);
      expect(Object.keys(deviceKeys[c.binding.user])).toEqual([c.binding.device]);
      expect(Object.hasOwn(queryResponse.nativeResponse.master_keys as object, b.binding.user)).toBe(false);
      await dispatcher.acceptResponse(query, queryResponse);
      expect(claim.body === claimBody && query.body === queryBody).toBe(true);
      expect((await a.device(d)).isVerified()).toBe(true);
      await verifyPair(a, c); await a.admit(c); await c.admit(a);
      await a.send(c, "Mixed response surviving peer"); await c.sync();
      expect(c.received).toHaveLength(1);
      console.info("voice-generation-mixed-public-api", JSON.stringify({ queryUsers: 2, claimUsers: 2, currentClaimed: 1, retiredClaimed: 0, retryConsumed: 0 }));
    } finally { dispatcher.release(); [a, b, c, d].forEach((owner) => owner.close()); }
  }, 30_000);

  it("rejects unsupported ToDevice fanout before any processing without constructing native queue work", () => {
    const call = randomUUID();
    const user = `@voice_${call}_${randomUUID()}:opendiscord.invalid`;
    const peer = `@voice_${call}_${randomUUID()}:opendiscord.invalid`;
    expect(() => validateGenerationToDevice({ messages: { [user]: { [randomUUID()]: {} }, [peer]: { [randomUUID()]: {} } } }, call)).toThrow("single-target");
    expect(() => validateGenerationToDevice({ messages: { [user]: { "*": {} } } }, call)).toThrow("single device");
  });

  it("rejects a genuinely decrypted old-generation control and requires an actual current peer receipt", async () => {
    await C.initAsync();
    const server = new GenerationServer();
    const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server);
    const dispatcher = new GenerationDispatcher(a, server);
    try {
      await verifyPair(a, b); await a.admit(b); await b.admit(a);
      const oldEpoch = randomUUID();
      await a.out(await encryptGenerationControl(a, b, server.generation, oldEpoch));
      const fetchedBeforeTransition = server.take(b);
      expect(fetchedBeforeTransition.events).toHaveLength(1);
      server.advance();
      const epoch = randomUUID();
      expect(await receiveGenerationControls(b, a, fetchedBeforeTransition, server.generation, epoch)).toBe(0);
      const retired = await encryptGenerationControl(a, b, server.generation, epoch);
      await dispatcher.retire(retired);
      expect(await receiveGenerationControls(b, a, server.take(b), server.generation, epoch)).toBe(0);
      const current = await encryptGenerationControl(a, b, server.generation, epoch);
      await a.out(current);
      expect(server.queued(b)).toBe(1);
      expect(await receiveGenerationControls(b, a, server.take(b), server.generation, epoch)).toBe(1);
    } finally { dispatcher.release(); a.close(); b.close(); }
  }, 30_000);

  it("fences late committed HTTP responses and completes original native work exactly once", async () => {
    await C.initAsync();
    const server = new GenerationServer();
    const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server);
    const dispatcher = new GenerationDispatcher(a, server);
    try {
      await a.query([a, b]); await b.query([a, b]);
      const [flow, request] = (await a.device(b)).requestVerification([C.VerificationMethod.SasV1]);
      a.registerFlow(b.binding.user, flow.flowId);
      const sentId = randomUUID(), originalGeneration = server.generation;
      const committed = await server.process(a, request, originalGeneration, "send", sentId);
      expect(committed.enqueued).toBe(1);
      expect(await server.process(a, request, originalGeneration, "send", sentId)).toBe(committed);
      expect(server.queued(b)).toBe(1);
      // Recipient actually saw the old request before transition. Retirement cannot retract it.
      await b.sync();
      expect(b.machine.getVerificationRequest(new C.UserId(a.binding.user), flow.flowId)).toBeDefined();
      server.advance(); flow.cancel();
      const retirementId = randomUUID();
      const retired = await server.process(a, request, server.generation, "retire", retirementId);
      expect(retired.enqueued).toBe(0);
      expect(await server.process(a, request, server.generation, "retire", retirementId)).toBe(retired);
      await dispatcher.acceptResponse(request, retired);
      await dispatcher.acceptResponse(request, retired);
      expect(dispatcher.completions.get(request.id)).toBe(1);
      await expect(dispatcher.acceptResponse(request, committed)).rejects.toThrow("Stale response fenced");
      await expect(server.process(a, request, originalGeneration, "send", sentId)).rejects.toThrow("Current sender/generation");
      expect(server.queued(b)).toBe(0);
      server.remove(a);
      await expect(server.process(a, request, server.generation, "retire", retirementId)).rejects.toThrow("Current sender/generation");
      await expect(dispatcher.acceptResponse(request, retired)).rejects.toThrow("Sender is no longer current");
      expect(dispatcher.completions.get(request.id)).toBe(1);
    } finally { dispatcher.release(); a.close(); b.close(); }
  }, 30_000);

  it("recovers after retiring the original Olm prekey message without changing owner keys", async () => {
    await C.initAsync();
    const server = new GenerationServer();
    const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server);
    const dispatcher = new GenerationDispatcher(a, server);
    try {
      await verifyPair(a, b); await a.admit(b); await b.admit(a);
      const before = identity(a);
      const claim = await a.machine.getMissingSessions([new C.UserId(b.binding.user)]);
      if (!claim) throw new Error("Expected genuine initial Olm claim.");
      await a.out(claim);
      const payload = { version: 1, purpose: "ephemeral-voice-proof", sender: a.binding, recipient: b.binding, transaction: randomUUID(), message: "Retired initial message" };
      const encrypted = await (await a.device(b)).encryptToDeviceEvent("app.opendiscord.voice.proof", payload, C.CollectStrategy.onlyTrustedDevices());
      const ciphertext = JSON.parse(encrypted) as { ciphertext: Record<string, { type: number }> };
      expect(Object.values(ciphertext.ciphertext).every((item) => item.type === 0)).toBe(true);
      const id = randomUUID();
      const request = new C.ToDeviceRequest(id, "m.room.encrypted", id, JSON.stringify({ messages: { [b.binding.user]: { [b.binding.device]: JSON.parse(encrypted) } } }));
      const originalBody = request.body;
      server.advance(); await dispatcher.retire(request);
      expect(request.body === originalBody).toBe(true);
      expect(server.queued(b)).toBe(0); expect(b.received).toHaveLength(0);
      await a.send(b, "Legitimate recovery"); await b.sync();
      expect(b.received.at(-1)?.message).toBe("Legitimate recovery");
      await b.send(a, "Real Olm acknowledgement"); await a.sync();
      await a.send(b, "Subsequent legitimate control"); await b.sync();
      expect(b.received).toHaveLength(2);
      expect(identity(a)).toEqual(before);
      expect((await a.device(b)).isVerified()).toBe(true);
    } finally { dispatcher.release(); a.close(); b.close(); }
  }, 30_000);

  it("processes actual empty query/claim responses without acquiring a departed peer session", async () => {
    await C.initAsync();
    const server = new GenerationServer();
    const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server), c = await EphemeralVoice.open(server);
    const dispatcher = new GenerationDispatcher(a, server);
    try {
      await verifyPair(a, b); await verifyPair(a, c);
      const departedDevice = await a.device(b);
      server.remove(b); server.advance();
      const claim = await a.machine.getMissingSessions([new C.UserId(b.binding.user)]);
      if (!claim) throw new Error("Expected native missing session request.");
      const receiptId = randomUUID();
      const response = await server.process(a, claim, server.generation, "send", receiptId);
      expect(response.disposition).toBe("processed-absent");
      expect(response.nativeResponse).toEqual({ one_time_keys: {}, failures: {} });
      expect(await server.process(a, claim, server.generation, "send", receiptId)).toBe(response);
      await a.machine.markRequestAsSent(claim.id, claim.type, JSON.stringify(response.nativeResponse));
      // Native 18.9 suppresses an immediate repeated empty claim. This is not session acquisition.
      const second = await a.machine.getMissingSessions([new C.UserId(b.binding.user)]);
      expect(second).toBeNull();
      await expect(departedDevice.encryptToDeviceEvent("app.opendiscord.voice.proof", { purpose: "benign-empty-claim-proof" }, C.CollectStrategy.onlyTrustedDevices())).rejects.toThrow();
      const query = a.machine.queryKeysForUsers([new C.UserId(b.binding.user)]);
      const queryResponse = await server.process(a, query, server.generation, "send", randomUUID());
      expect(queryResponse.nativeResponse).toEqual({ device_keys: { [b.binding.user]: {} }, master_keys: {}, self_signing_keys: {}, user_signing_keys: {}, failures: {} });
      await a.machine.markRequestAsSent(query.id, query.type, JSON.stringify(queryResponse.nativeResponse));
      expect(await a.machine.getDevice(new C.UserId(b.binding.user), new C.DeviceId(b.binding.device))).toBeUndefined();
      expect((await a.device(c)).isVerified()).toBe(true);
      await a.admit(c); await c.admit(a); await a.send(c, "Surviving current peer"); await c.sync();
      expect(c.received).toHaveLength(1);
      expect(server.queued(c)).toBe(0);
    } finally { dispatcher.release(); a.close(); b.close(); c.close(); }
  }, 30_000);

  it("feeds genuine per-target signature refusal to native without storing signatures or inventing invalid-signature errors", async () => {
    await C.initAsync();
    const server = new GenerationServer();
    const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server), c = await EphemeralVoice.open(server);
    const dispatcher = new GenerationDispatcher(a, server);
    try {
      await verifyPair(a, c);
      const paused = dispatcher.pauseAtType(C.RequestType.SignatureUpload);
      const flow = verifyPair(a, b).then(() => "completed", () => "interrupted");
      const pending = await paused;
      expect(pending.request).toBeInstanceOf(C.SignatureUploadRequest);
      expect(typeof pending.request.id).toBe("string");
      console.info("voice-generation-signature-public-api", JSON.stringify({ users: Object.keys(JSON.parse(pending.request.body)).length, includesOwn: Object.hasOwn(JSON.parse(pending.request.body), a.binding.user) }));
      const trustBeforeResponse = (await a.device(b)).isVerified();
      server.remove(b); server.advance();
      const writesBefore = server.signatureWrites.get(b.binding.user) ?? 0;
      const receipt = await dispatcher.respondPending();
      expect(receipt.disposition).toBe("processed-refused");
      const failures = receipt.nativeResponse.failures as Record<string, Record<string, { errcode: string }>>;
      expect(Object.keys(failures)).toEqual([b.binding.user]);
      expect(Object.values(failures[b.binding.user]).every((failure) => failure.errcode === "M_FORBIDDEN")).toBe(true);
      expect(server.signatureWrites.get(b.binding.user) ?? 0).toBe(writesBefore);
      expect(await flow).toBe("interrupted");
      const stored = await a.machine.getDevice(new C.UserId(b.binding.user), new C.DeviceId(b.binding.device));
      expect(stored?.isVerified()).toBe(trustBeforeResponse);
      const repeated = (await a.machine.outgoingRequests()).filter((request) => request.type === C.RequestType.SignatureUpload && request.id === pending.request.id);
      expect(repeated).toHaveLength(0);
      expect((await a.device(c)).isVerified()).toBe(true);
    } finally { dispatcher.release(); a.close(); b.close(); c.close(); }
  }, 30_000);

  it("keeps the independent native DM baseline invariant", async () => {
    await C.initAsync();
    const dm = await C.OlmMachine.initialize(new C.UserId(`@dm_${randomUUID()}:opendiscord.invalid`), new C.DeviceId(randomUUID()));
    const room = new C.RoomId(`!dm_${randomUUID()}:opendiscord.invalid`);
    await dm.shareRoomKey(room, [], new C.EncryptionSettings());
    const history = { msgtype: "m.text", body: "Independent benign DM baseline", transaction: randomUUID() };
    const event = { type: "m.room.encrypted", event_id: `$${randomUUID()}`, sender: dm.userId.toString(), origin_server_ts: Date.now(), content: JSON.parse(await dm.encryptRoomEvent(room, "m.room.message", JSON.stringify(history))) };
    const decryptHistory = async () => JSON.parse((await dm.decryptRoomEvent(JSON.stringify(event), room, new C.DecryptionSettings(C.TrustRequirement.Untrusted))).event).content;
    expect(await decryptHistory()).toEqual(history);
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value;
    const digest = async () => {
      const counts = await dm.roomKeyCounts();
      const requests = (await dm.outgoingRequests()).map((r) => ({
        type: r.type,
        // Accepted baseline proves only upload/query request IDs are volatile.
        id: r.type === C.RequestType.KeysUpload || r.type === C.RequestType.KeysQuery ? null : r.id,
        body: createHash("sha256").update(JSON.stringify(canonical(JSON.parse(r.body)))).digest("hex"),
      })).sort((left, right) => left.type - right.type || left.body.localeCompare(right.body) || (left.id ?? "").localeCompare(right.id ?? ""));
      return createHash("sha256").update(JSON.stringify({ curve: dm.identityKeys.curve25519.toBase64(), ed: dm.identityKeys.ed25519.toBase64(), total: counts.total, backedUp: counts.backedUp, verified: (await dm.getIdentity(dm.userId))?.isVerified() ?? false, flows: dm.getVerificationRequests(dm.userId).map((flow) => flow.flowId), requests })).digest("hex");
    };
    const before = await digest();
    expect(await digest()).toBe(before);
    const server = new GenerationServer();
    const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server);
    try { await verifyPair(a, b); expect(await digest()).toBe(before); expect(await decryptHistory()).toEqual(history); }
    finally { a.close(); b.close(); expect(await digest()).toBe(before); expect(await decryptHistory()).toEqual(history); dm.close(); }
  }, 30_000);

  for (const phase of ["request", "ready", "start", "key", "mac", "done"]) {
    for (const removed of [false, true]) {
      it(`retires pending ${phase} to a ${removed ? "departed" : "current"} peer and verifies a fresh surviving peer`, async () => {
        await C.initAsync();
        const server = new GenerationServer();
        const a = await EphemeralVoice.open(server), b = await EphemeralVoice.open(server), c = await EphemeralVoice.open(server), d = await EphemeralVoice.open(server);
        const dispatchers = [a, b, c, d].map((owner) => new GenerationDispatcher(owner, server));
        const before = identity(a);
        try {
          await verifyPair(a, d);
          const retainedPeerIdentity = identity(d);
          const [left] = dispatchers;
          const paused = left.pauseAt(phase);
          const oldFlow = (phase === "ready" ? verifyPair(b, a) : verifyPair(a, b)).then(() => "completed", () => "interrupted");
          const pending = await paused;
          if (!(pending.request instanceof C.ToDeviceRequest)) throw new Error("Expected native ToDevice.");
          expect(pending.request.event_type).toBe(`m.key.verification.${phase}`);
          const immutable = { id: pending.request.id, type: pending.request.type, body: pending.request.body };
          if (removed) {
            server.remove(b);
            await expect(server.process(a, pending.request, server.generation, "send", randomUUID())).rejects.toThrow("Destination is outside this active call");
            expect(left.completions.has(pending.request.id)).toBe(false);
          }
          server.advance();
          for (const dispatcher of dispatchers) if (server.owns(dispatcher.owner.binding)) await dispatcher.cancelAndRetire();
          expect(await oldFlow).toBe("interrupted");
          expect(pending.request.id === immutable.id && pending.request.type === immutable.type && pending.request.body === immutable.body).toBe(true);
          expect(server.retired.length).toBeGreaterThan(0);
          expect(server.retired.every((receipt) => receipt.enqueued === 0 && receipt.disposition === "processed-retired")).toBe(true);
          expect(identity(a)).toEqual(before);
          expect((await a.device(d)).isVerified()).toBe(true);
          expect((await d.device(a)).isVerified()).toBe(true);
          expect(identity(d)).toBe(retainedPeerIdentity);
          expect(server.enrolledUsers.size).toBe(4);
          expect(server.generation).toBe(2);
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
        } finally { dispatchers.forEach((dispatcher) => dispatcher.release()); [a, b, c, d].forEach((owner) => owner.close()); }
      }, 30_000);
    }
  }
});
