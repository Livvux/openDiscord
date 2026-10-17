import { denyVoiceMethod, postVoiceControl } from "@/server/voice-http";

export const POST = postVoiceControl;
export const GET = denyVoiceMethod;
export const HEAD = denyVoiceMethod;
export const PUT = denyVoiceMethod;
export const PATCH = denyVoiceMethod;
export const DELETE = denyVoiceMethod;
export const OPTIONS = denyVoiceMethod;
