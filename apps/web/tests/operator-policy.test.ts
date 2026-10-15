import { afterEach, expect, it, vi } from "vitest";
import { getMinimumAge, getOperatorDetails } from "@/server/operator-policy";

afterEach(() => vi.unstubAllEnvs());
it("defaults to the approved age and rejects invalid runtime policy", () => {
  vi.stubEnv("MINIMUM_AGE", "16");
  expect(getMinimumAge()).toBe(16);
  for (const age of ["0", "12", "16.5", "invalid", "100"]) {
    vi.stubEnv("MINIMUM_AGE", age);
    expect(() => getMinimumAge()).toThrow();
  }
});
it("never publishes the official operator as another instance's operator", () => {
  for (const key of ["OPERATOR_NAME", "OPERATOR_ADDRESS", "OPERATOR_COUNTRY", "OPERATOR_EMAIL"]) vi.stubEnv(key, "");
  vi.stubEnv("BETTER_AUTH_URL", "https://chat.example.org");
  expect(getOperatorDetails()).toBeNull();
  vi.stubEnv("BETTER_AUTH_URL", "https://opendiscord.app");
  expect(getOperatorDetails()).toMatchObject({ name: "lk media", email: "info@opendiscord.app" });
  vi.stubEnv("BETTER_AUTH_URL", "https://opendiscord.app.evil.example");
  expect(getOperatorDetails()).toBeNull();
  vi.stubEnv("OPERATOR_NAME", "Another operator");
  vi.stubEnv("OPERATOR_ADDRESS", "Another address");
  vi.stubEnv("OPERATOR_COUNTRY", "Another country");
  vi.stubEnv("OPERATOR_EMAIL", "operator@example.org");
  expect(getOperatorDetails()?.name).toBe("Another operator");
});
