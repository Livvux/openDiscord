import { afterAll, afterEach, expect, it } from "vitest";
import { createVoiceProductOwner } from "@/lib/voice/crypto-owner";
import { acquireVoiceOwnerGuard } from "@/lib/voice/owner-guard";
import { handleVoiceCrypto } from "@/server/voice-control";
import { agreementServiceFixture, cleanupAgreementUsers, closeAgreementFixture } from "./fixtures/voice-agreement-service";
afterEach(closeAgreementFixture); afterAll(cleanupAgreementUsers);
it("freezes exactly the bound product port of one actual Owner, omitting primitives and raw native access", async () => {
  const [endpoint] = await agreementServiceFixture(1, 0);
  const port = await createVoiceProductOwner({ accountId: endpoint.userId, guard: await acquireVoiceOwnerGuard(endpoint.userId), snapshot: endpoint.snapshot, lifetime: { signal: endpoint.lifetime.signal, assertCurrent() {} }, onFence: endpoint.fence, transport: ({ binding, request }) => handleVoiceCrypto({ userId: endpoint.userId, sessionId: endpoint.sessionId, memberId: endpoint.snapshot.memberId, secret: endpoint.secret }, { ...binding, request }) });
  try {
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.keys(port).sort()).toEqual(["selectAudience", "createContextOffer", "sendContextControl", "receiveAgreement", "stageOfferedContext", "acceptContextControl", "retainPendingMaterial", "installContext", "contextAgreementComplete", "sendControl", "close", "query", "flush", "requestVerification", "verificationStep", "verificationStates", "admit", "transition"].sort());
    expect(port).not.toHaveProperty("receive"); expect(port).not.toHaveProperty("setControlContext"); expect(port).not.toHaveProperty("machine");
    const { selectAudience, createContextOffer, stageOfferedContext, contextAgreementComplete, installContext } = port;
    expect(await selectAudience([endpoint.snapshot.memberId], 1)).toBeUndefined();
    const offer = await createContextOffer(); await stageOfferedContext(offer.ref);
    expect(await contextAgreementComplete(offer.ref)).toBe(true); expect(await installContext(offer.ref)).toEqual([]);
  } finally { await port.close(); }
});
