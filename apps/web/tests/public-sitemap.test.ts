import { beforeEach, describe, expect, it, vi } from "vitest";

const { connection, listPublicChannels } = vi.hoisted(() => ({ connection: vi.fn(), listPublicChannels: vi.fn() }));
vi.mock("next/server", () => ({ connection }));
vi.mock("@/server/public-channels", () => ({ listPublicChannels }));
import { GET } from "@/app/sitemap.xml/route";

describe("request-time public sitemap", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("does not read public data without a real request boundary", async () => {
    connection.mockRejectedValue(new Error("No incoming request during prerender"));
    await expect(GET()).rejects.toThrow("No incoming request during prerender");
    expect(listPublicChannels).not.toHaveBeenCalled();
  });

  it("waits for the request and rechecks current publication on every uncached response", async () => {
    let acceptRequest!: () => void;
    connection.mockReturnValueOnce(new Promise<void>((resolve) => { acceptRequest = resolve; }));
    listPublicChannels.mockResolvedValueOnce({ channels: [{ id: "019b49df-cb21-7000-8000-000000000001" }] });
    const pending = GET();
    expect(listPublicChannels).not.toHaveBeenCalled();
    acceptRequest();
    const published = await pending;
    expect(await published.text()).toContain("/public/019b49df-cb21-7000-8000-000000000001");
    expect(published.headers.get("cache-control")).toBe("private, no-store");
    expect(published.headers.get("cdn-cache-control")).toBe("no-store");
    connection.mockResolvedValueOnce(undefined);
    listPublicChannels.mockResolvedValueOnce({ channels: [] });
    const unpublished = await GET();
    expect(await unpublished.text()).not.toContain("/public/");
    expect(connection).toHaveBeenCalledTimes(2);
    expect(listPublicChannels).toHaveBeenCalledTimes(2);
  });
});
