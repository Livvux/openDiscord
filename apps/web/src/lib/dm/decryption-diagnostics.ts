import type * as Matrix from "@matrix-org/matrix-sdk-crypto-wasm";

export type DecryptionStage = "envelope" | "sdk_decrypt" | "shield" | "sender_binding" | "device_trust" | "plaintext_schema" | "message_binding" | "history_schema" | "replay_storage";
export type DecryptionCode = "MissingRoomKey" | "UnknownMessageIndex" | "MismatchedIdentityKeys" | "UnknownSenderDevice" | "UnsignedSenderDevice" | "SenderIdentityVerificationViolation" | "UnableToDecrypt" | "MismatchedSender" | "unknown";
export type ShieldColor = "Red" | "Grey" | "None" | "unknown";
export type ShieldCode = "AuthenticityNotGuaranteed" | "UnknownDevice" | "UnsignedDevice" | "UnverifiedIdentity" | "VerificationViolation" | "MismatchedSender" | "unknown";
export type ShieldDiagnostic = { shieldColor: ShieldColor; shieldCode: ShieldCode };
export type DecryptionDiagnostic = { stage: Exclude<DecryptionStage, "shield">; code: DecryptionCode; shieldColor?: never; shieldCode?: never } | ({ stage: "shield"; code: "unknown" } & ShieldDiagnostic);
type DiagnosticSDK = Pick<typeof Matrix, "MegolmDecryptionError" | "DecryptionErrorCode" | "ShieldColor" | "ShieldStateCode">;

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

export function publicShieldColor(color: Matrix.ShieldColor | undefined, C: DiagnosticSDK): ShieldColor {
  switch (color) {
    case C.ShieldColor.Red: return "Red";
    case C.ShieldColor.Grey: return "Grey";
    case C.ShieldColor.None: return "None";
    default: return "unknown";
  }
}

export function publicShieldCode(code: Matrix.ShieldStateCode | undefined, C: DiagnosticSDK): ShieldCode {
  switch (code) {
    case C.ShieldStateCode.AuthenticityNotGuaranteed: return "AuthenticityNotGuaranteed";
    case C.ShieldStateCode.UnknownDevice: return "UnknownDevice";
    case C.ShieldStateCode.UnsignedDevice: return "UnsignedDevice";
    case C.ShieldStateCode.UnverifiedIdentity: return "UnverifiedIdentity";
    case C.ShieldStateCode.VerificationViolation: return "VerificationViolation";
    case C.ShieldStateCode.MismatchedSender: return "MismatchedSender";
    default: return "unknown";
  }
}

export function decryptionDiagnostic(stage: DecryptionStage, error: unknown, C: DiagnosticSDK, shield?: ShieldDiagnostic): DecryptionDiagnostic {
  if (stage === "shield") return { stage, code: "unknown", shieldColor: shield?.shieldColor ?? "unknown", shieldCode: shield?.shieldCode ?? "unknown" };
  return { stage, code: stage === "sdk_decrypt" && error instanceof C.MegolmDecryptionError ? publicDecryptionCode(error.code, C) : "unknown" };
}
