import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/mail", () => ({ mailEnabled: false, sendMail: vi.fn() }));
import { auth } from "@/lib/auth";

describe("email correction without SMTP", () => {
  it("disables the flow instead of writing verification links into operator logs", () => {
    expect(auth.options.user?.changeEmail?.enabled).toBe(false);
    expect(auth.options.user?.changeEmail?.updateEmailWithoutVerification).toBe(false);
  });
});
