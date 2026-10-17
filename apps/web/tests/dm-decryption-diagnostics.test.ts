import { randomUUID } from "node:crypto";
import * as C from "@matrix-org/matrix-sdk-crypto-wasm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivateMessaging } from "@/lib/dm/client";
import { matrixUser, type DirectEnvelope } from "@/lib/dm/contracts";
import { decryptionDiagnostic, publicDecryptionCode, publicShieldCode, publicShieldColor, type DecryptionStage } from "@/lib/dm/decryption-diagnostics";

const fixtures = vi.hoisted(() => ({ initialize: vi.fn(), openHistory: vi.fn() }));
vi.mock("@matrix-org/matrix-sdk-crypto-wasm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@matrix-org/matrix-sdk-crypto-wasm")>();
  return { ...actual, OlmMachine: { initialize: fixtures.initialize } };
});
vi.mock("@/lib/dm/history", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dm/history")>();
  return { ...actual, HistoryStore: { open: fixtures.openHistory } };
});

const genericError = "Cannot decrypt or authenticate this message. Verify devices, sync, or restore a trusted history backup.";
beforeAll(() => C.initAsync());

describe("bounded public SDK classification", () => {
  it("maps every pinned public enum explicitly", () => {
    const codes = ["MissingRoomKey", "UnknownMessageIndex", "MismatchedIdentityKeys", "UnknownSenderDevice", "UnsignedSenderDevice", "SenderIdentityVerificationViolation", "UnableToDecrypt", "MismatchedSender"] as const;
    for (const code of codes) expect(publicDecryptionCode(C.DecryptionErrorCode[code], C)).toBe(code);
    expect(publicDecryptionCode(Number.MAX_SAFE_INTEGER, C)).toBe("unknown");
  });

  it("accepts only SDK error instances at the SDK boundary and never reads descriptions", () => {
    const error = C.MegolmDecryptionError.unable_to_decrypt("private description");
    try {
      expect(decryptionDiagnostic("sdk_decrypt", error, C)).toEqual({ stage: "sdk_decrypt", code: "UnableToDecrypt" });
      expect(decryptionDiagnostic("replay_storage", error, C)).toEqual({ stage: "replay_storage", code: "unknown" });
      const spoof = { code: C.DecryptionErrorCode.MissingRoomKey, get description() { throw new Error("Description must not be read"); } };
      expect(decryptionDiagnostic("sdk_decrypt", spoof, C)).toEqual({ stage: "sdk_decrypt", code: "unknown" });
      expect(decryptionDiagnostic("sdk_decrypt", new Error("private error"), C)).toEqual({ stage: "sdk_decrypt", code: "unknown" });
    } finally { error.free(); }
  });

  it("maps only public shield colors and reasons with fixed missing/future fallbacks", () => {
    for (const color of ["Red", "Grey", "None"] as const) expect(publicShieldColor(C.ShieldColor[color], C)).toBe(color);
    const codes = ["AuthenticityNotGuaranteed", "UnknownDevice", "UnsignedDevice", "UnverifiedIdentity", "VerificationViolation", "MismatchedSender"] as const;
    for (const code of codes) expect(publicShieldCode(C.ShieldStateCode[code], C)).toBe(code);
    for (const unknown of [undefined, Number.MAX_SAFE_INTEGER]) {
      expect(publicShieldColor(unknown, C)).toBe("unknown");
      expect(publicShieldCode(unknown, C)).toBe("unknown");
    }
  });
});

describe("per-message processing failure boundaries", () => {
  let client: PrivateMessaging;
  let envelope: DirectEnvelope;
  const user = "recipient", peer = "sender";
  const device = randomUUID(), conversation = randomUUID(), transaction = randomUUID();
  const plain = { msgtype: "m.text", body: "fixture plaintext", conversation, transaction };
  function shieldFixture(color: C.ShieldColor = C.ShieldColor.None, code?: C.ShieldStateCode) {
    return { color, code, get message(): never { throw new Error("Shield descriptions must not be read"); } };
  }
  function decryptedFixture() {
    return { sender: new C.UserId(matrixUser(peer)), senderDevice: new C.DeviceId(device), event: JSON.stringify({ content: plain }),
      shieldState: vi.fn(() => shieldFixture()) };
  }
  let decrypted: ReturnType<typeof decryptedFixture>;
  const machine = {
    outgoingRequests: vi.fn(async () => []),
    queryKeysForUsers: vi.fn(() => ({ type: C.RequestType.KeysQuery, body: "{}", id: "query" })),
    markRequestAsSent: vi.fn(), getIdentity: vi.fn(async () => ({})),
    decryptRoomEvent: vi.fn<(event: string, room: C.RoomId, settings: C.DecryptionSettings) => Promise<ReturnType<typeof decryptedFixture>>>(async () => decrypted), getDevice: vi.fn(async () => ({ isVerified: (): boolean => true, isCrossSignedByOwner: (): boolean => false })),
    close: vi.fn(),
  };
  const history = {
    cached: vi.fn(async () => []), archives: vi.fn(async () => []), pendingIdentity: vi.fn(async () => null),
    acceptEvent: vi.fn(), put: vi.fn(), close: vi.fn(),
  };

  beforeEach(async () => {
    decrypted = decryptedFixture();
    machine.decryptRoomEvent.mockResolvedValue(decrypted);
    machine.getDevice.mockResolvedValue({ isVerified: () => true, isCrossSignedByOwner: () => false });
    history.acceptEvent.mockResolvedValue(undefined);
    fixtures.initialize.mockResolvedValue(machine);
    fixtures.openHistory.mockResolvedValue(history);
    vi.stubGlobal("window", { isSecureContext: true, indexedDB: {}, addEventListener: vi.fn() });
    vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } });
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ id: randomUUID(), secret: "a".repeat(64), storeKey: "b".repeat(64) }), setItem: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
    client = await PrivateMessaging.open(user);
    envelope = { id: randomUUID(), conversationId: conversation, senderId: peer, deviceId: device, transactionId: transaction, createdAt: new Date().toISOString(),
      content: { algorithm: "m.megolm.v1.aes-sha2", sender_key: "a".repeat(43), device_id: device, session_id: "b".repeat(43), ciphertext: "c".repeat(64) } };
  });
  afterEach(() => { client?.close(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  const stages: DecryptionStage[] = ["envelope", "sdk_decrypt", "shield", "sender_binding", "device_trust", "plaintext_schema", "message_binding", "history_schema", "replay_storage"];
  it.each(stages)("classifies %s without retaining raw exceptions or message contents", async (stage) => {
    switch (stage) {
      case "envelope": envelope.conversationId = randomUUID(); break;
      case "sdk_decrypt": machine.decryptRoomEvent.mockRejectedValueOnce(new Error("private SDK exception")); break;
      case "shield": decrypted.shieldState.mockReturnValueOnce(shieldFixture(C.ShieldColor.Red)); break;
      case "sender_binding": decrypted.senderDevice = new C.DeviceId(randomUUID()); break;
      case "device_trust": machine.getDevice.mockResolvedValueOnce({ isVerified: () => false, isCrossSignedByOwner: () => false }); break;
      case "plaintext_schema": decrypted.event = "private invalid JSON"; break;
      case "message_binding": decrypted.event = JSON.stringify({ content: { ...plain, transaction: randomUUID() } }); break;
      case "history_schema": envelope.content = {}; break;
      case "replay_storage": history.acceptEvent.mockRejectedValueOnce(new Error("private storage exception")); break;
    }
    const [row] = await client.decrypt([envelope], conversation, peer);
    expect(row.body).toBeNull();
    expect(row.error).toBe(genericError);
    expect(row.diagnostic).toEqual(stage === "shield" ? { stage, code: "unknown", shieldColor: "Red", shieldCode: "unknown" } : { stage, code: "unknown" });
    expect(Object.keys(row.diagnostic ?? {}).sort()).toEqual(stage === "shield" ? ["code", "shieldCode", "shieldColor", "stage"] : ["code", "stage"]);
    expect(history.put).not.toHaveBeenCalled();
    if (stage !== "replay_storage") expect(history.acceptEvent).not.toHaveBeenCalled();
  });

  it.each([C.ShieldColor.Red, C.ShieldColor.Grey])("preserves shield rejection for public color %s without reading descriptions", async (color) => {
    decrypted.shieldState.mockReturnValueOnce(shieldFixture(color, C.ShieldStateCode.UnverifiedIdentity));
    const [row] = await client.decrypt([envelope], conversation, peer);
    expect(row.body).toBeNull();
    expect(row.error).toBe(genericError);
    expect(row.diagnostic).toEqual({ stage: "shield", code: "unknown", shieldColor: publicShieldColor(color, C), shieldCode: "UnverifiedIdentity" });
    expect(decrypted.shieldState).toHaveBeenCalledExactlyOnceWith(false);
    expect(machine.getDevice).not.toHaveBeenCalled();
    expect(history.acceptEvent).not.toHaveBeenCalled();
  });

  it("retains fixed unknown shield values if acquisition throws and keeps SDK codes separate", async () => {
    const error = C.MegolmDecryptionError.unable_to_decrypt("private shield acquisition exception");
    try {
      decrypted.shieldState.mockImplementationOnce(() => { throw error; });
      const [row] = await client.decrypt([envelope], conversation, peer);
      expect(row.body).toBeNull();
      expect(row.error).toBe(genericError);
      expect(row.diagnostic).toEqual({ stage: "shield", code: "unknown", shieldColor: "unknown", shieldCode: "unknown" });
      expect(decrypted.shieldState).toHaveBeenCalledExactlyOnceWith(false);
      expect(machine.getDevice).not.toHaveBeenCalled();
      expect(history.acceptEvent).not.toHaveBeenCalled();
    } finally { error.free(); }
  });

  it("rejects future shield values while exposing only fixed unknown classifications", async () => {
    decrypted.shieldState.mockReturnValueOnce(shieldFixture(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    const [row] = await client.decrypt([envelope], conversation, peer);
    expect(row.body).toBeNull();
    expect(row.error).toBe(genericError);
    expect(row.diagnostic).toEqual({ stage: "shield", code: "unknown", shieldColor: "unknown", shieldCode: "unknown" });
    expect(decrypted.shieldState).toHaveBeenCalledExactlyOnceWith(false);
    expect(machine.getDevice).not.toHaveBeenCalled();
    expect(history.acceptEvent).not.toHaveBeenCalled();
  });

  it("retains a real SDK error category while keeping the visible error generic", async () => {
    const error = C.MegolmDecryptionError.unable_to_decrypt("private SDK description");
    try {
      machine.decryptRoomEvent.mockRejectedValueOnce(error);
      const [row] = await client.decrypt([envelope], conversation, peer);
      expect(row.body).toBeNull();
      expect(row.error).toBe(genericError);
      expect(row.diagnostic).toEqual({ stage: "sdk_decrypt", code: "UnableToDecrypt" });
    } finally { error.free(); }
  });

  it("adds no diagnostic metadata to successful rows and preserves SDK and replay checks", async () => {
    const [row] = await client.decrypt([envelope], conversation, peer);
    expect(row.body).toBe(plain.body);
    expect(row).not.toHaveProperty("diagnostic");
    expect(row).not.toHaveProperty("error");
    expect(machine.decryptRoomEvent.mock.calls[0][2].sender_device_trust_requirement).toBe(C.TrustRequirement.CrossSigned);
    expect(decrypted.shieldState).toHaveBeenCalledExactlyOnceWith(false);
    expect(machine.getDevice).toHaveBeenCalledWith(decrypted.sender, decrypted.senderDevice);
    expect(history.acceptEvent).toHaveBeenCalledWith(envelope);
    expect(history.put).toHaveBeenCalledOnce();
  });

  it("trusts an unverified peer device on first use when its owner's identity signed it", async () => {
    machine.getDevice.mockResolvedValueOnce({ isVerified: () => false, isCrossSignedByOwner: () => true });
    const [row] = await client.decrypt([envelope], conversation, peer);
    expect(row.body).toBe(plain.body);
  });

  it("rejects a cross-signed device once the peer's pinned identity changed", async () => {
    const changed = Object.assign(Object.create(C.OtherUserIdentity.prototype), { identityNeedsUserApproval: () => true, hasVerificationViolation: () => false });
    machine.getIdentity.mockResolvedValueOnce(changed);
    machine.getDevice.mockResolvedValueOnce({ isVerified: () => false, isCrossSignedByOwner: () => true });
    const [row] = await client.decrypt([envelope], conversation, peer);
    expect(row.body).toBeNull();
    expect(row.diagnostic).toEqual({ stage: "device_trust", code: "unknown" });
  });

  it("keeps failures per envelope and drops their classification on a later successful refresh", async () => {
    history.acceptEvent.mockRejectedValueOnce(new Error("private storage exception"));
    const next = { ...envelope, id: randomUUID() };
    const rows = await client.decrypt([envelope, next], conversation, peer);
    expect(rows[0].diagnostic).toEqual({ stage: "replay_storage", code: "unknown" });
    expect(rows[1].body).toBe(plain.body);
    expect(rows[1]).not.toHaveProperty("diagnostic");
    const [refreshed] = await client.decrypt([envelope], conversation, peer);
    expect(refreshed.body).toBe(plain.body);
    expect(refreshed).not.toHaveProperty("diagnostic");
  });
});
