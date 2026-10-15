/** Why an existing account may not use the app. Shared by the server gate and the sign-in page. */
export type BlockedState = "suspended" | "pending" | "rejected";
export const BLOCKED_MESSAGES: Record<BlockedState, string> = {
  suspended: "Your account is suspended. Contact the instance operator.",
  pending: "Your account is waiting for approval. You can sign in once an administrator approves it.",
  rejected: "Your request for access was not approved. Contact the instance operator if you think this is a mistake.",
};
