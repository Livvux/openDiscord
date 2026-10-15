import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("@/server/stream-leases", () => ({ acquireStreamLease: mocks.acquire, MAX_STREAM_LIFETIME_MS: 600_000 }));
vi.mock("@/server/session", () => ({ requireUser: vi.fn(async () => ({ id: "stream-user" })) }));
vi.mock("@/server/access", () => ({ loadAuthority: vi.fn(async () => ({})), loadChannelAuthority: vi.fn() }));
vi.mock("@/server/messages", () => ({ getMessageForBroadcast: vi.fn() }));
vi.mock("@/server/presence", () => ({ mutedCommunities: vi.fn(), touchPresence: vi.fn(async () => {}) }));
vi.mock("@/server/realtime", () => ({ hub: { subscribe: mocks.subscribe }, userTopic: (id: string) => id }));

import { GET as personalEvents } from "@/app/api/me/events/route";
import { GET as communityEvents } from "@/app/api/communities/[communityId]/events/route";

const communityId = "01960000-0000-7000-8000-000000000001";
const routes = [
  { name: "personal", get: (request: Request) => personalEvents(request) },
  { name: "community", get: (request: Request) => communityEvents(request, { params: Promise.resolve({ communityId }) }) },
];
afterEach(() => {
  vi.clearAllMocks();
  mocks.acquire.mockReset();
  mocks.subscribe.mockReset();
});

for (const route of routes) describe(`${route.name} stream lifecycle`, () => {
  it("releases a lease acquired after the request was aborted without subscribing", async () => {
    const release = vi.fn(async () => {});
    let acquired!: (release: () => Promise<void>) => void;
    mocks.acquire.mockReturnValue(new Promise<() => Promise<void>>((resolve) => { acquired = resolve; }));
    const abort = new AbortController();
    const request = new Request("http://localhost/events", { signal: abort.signal });
    const remove = vi.spyOn(request.signal, "removeEventListener");
    const pending = route.get(request);
    await vi.waitFor(() => expect(mocks.acquire).toHaveBeenCalled());
    abort.abort();
    acquired(release);
    const response = await pending;
    expect(await response.text()).toBe("");
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cancels the subscription, timers and abort listener when the reader cancels", async () => {
    const release = vi.fn(async () => {});
    const unsubscribe = vi.fn();
    mocks.acquire.mockResolvedValue(release);
    mocks.subscribe.mockReturnValue(unsubscribe);
    const abort = new AbortController();
    const request = new Request("http://localhost/events", { signal: abort.signal });
    const remove = vi.spyOn(request.signal, "removeEventListener");
    const response = await route.get(request);
    expect(response.status).toBe(200);
    expect(mocks.acquire).toHaveBeenCalledWith("stream-user", route.name);
    await response.body?.cancel();
    abort.abort();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("releases the lease if subscription setup fails", async () => {
    const release = vi.fn(async () => {});
    mocks.acquire.mockResolvedValue(release);
    mocks.subscribe.mockImplementation(() => { throw new Error("hub unavailable"); });
    await expect(route.get(new Request("http://localhost/events"))).rejects.toThrow("hub unavailable");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
