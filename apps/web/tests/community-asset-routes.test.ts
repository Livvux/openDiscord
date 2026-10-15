import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/community-assets", () => ({ createCommunityAsset: vi.fn(), deleteCommunityAsset: vi.fn(), listCommunityAssets: vi.fn() }));
import { POST } from "@/app/api/communities/[communityId]/assets/route";
import { DELETE } from "@/app/api/communities/[communityId]/assets/[assetId]/route";
import { createCommunityAsset, deleteCommunityAsset } from "@/server/community-assets";
import { requireUser } from "@/server/session";

describe("community asset mutation origins", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it.each([undefined, "https://foreign.invalid", "null"])("refuses origin %s before authentication, staging or deletion", async (origin) => {
    const headers: Record<string, string> = { "content-type": "text/plain" };
    if (origin !== undefined) headers.origin = origin;
    const upload = new Request("https://local.invalid/api/communities/x/assets", { method: "POST", headers, body: "not read" });
    const removal = new Request("https://local.invalid/api/communities/x/assets/y", { method: "DELETE", headers });
    expect((await POST(upload, { params: Promise.resolve({ communityId: "x" }) })).status).toBe(403);
    expect((await DELETE(removal, { params: Promise.resolve({ communityId: "x", assetId: "y" }) })).status).toBe(403);
    expect(requireUser).not.toHaveBeenCalled();
    expect(createCommunityAsset).not.toHaveBeenCalled();
    expect(deleteCommunityAsset).not.toHaveBeenCalled();
    expect(upload.bodyUsed).toBe(false);
  });
});
