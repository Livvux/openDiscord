import type * as Matrix from "@matrix-org/matrix-sdk-crypto-wasm";

export type DecryptionStage = "envelope" | "sdk_decrypt" | "shield" | "sender_binding" | "device_trust" | "plaintext_schema" | "message_binding" | "history_schema" | "replay_storage";
export type DecryptionCode = "MissingRoomKey" | "UnknownMessageIndex" | "MismatchedIdentityKeys" | "UnknownSenderDevice" | "UnsignedSenderDevice" | "SenderIdentityVerificationViolation" | "UnableToDecrypt" | "MismatchedSender" | "unknown";
export type DecryptionDiagnostic = { stage: DecryptionStage; code: DecryptionCode };
type DiagnosticSDK = Pick<typeof Matrix, "MegolmDecryptionError" | "DecryptionErrorCode">;

export function publicDecryptionCode(code: Matrix.DecryptionErrorCode, C: DiagnosticSDK): DecryptionCode {
  switch (code) {
    case C.DecryptionErrorCode.MissingRoomKey: return "MissingRoomKey";
    case C.DecryptionErrorCode.UnknownMessageIndex: return "UnknownMessageIndex";
    case C.DecryptionErrorCode.MismatchedIdentityKeys: return "MismatchedIdentityKeys";
    case C.DecryptionErrorCode.UnknownSenderDevice: return "UnknownSenderDevice";
    case C.DecryptionErrorCode.UnsignedSenderDevice: return "UnsignedSenderDevice";
    case C.DecryptionErrorCode.SenderIdentityVerificationViolation: return "SenderIdentityVerificationViolation";
    case C.DecryptionErrorCode.UnableToDecrypt: return "UnableToDecrypt";
    case C.DecryptionErrorCode.MismatchedSender: return "MismatchedSender";
    default: return "unknown";
  }
}

export function decryptionDiagnostic(stage: DecryptionStage, error: unknown, C: DiagnosticSDK): DecryptionDiagnostic {
  return { stage, code: stage === "sdk_decrypt" && error instanceof C.MegolmDecryptionError ? publicDecryptionCode(error.code, C) : "unknown" };
}
