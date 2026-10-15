# Community emoji and sticker design

The roadmap-completion authorization covers this increment. Root owns feat/community-assets in its separate worktree. Voice owns its isolated worker proof; migration0028 is reserved for this asset increment until coordinated otherwise. Preserve the existing flat UI, private community model, Unicode reactions and legacy import readers.

## Product boundary

Community managers use the existing ManageCommunity permission to upload and delete a private static raster library. Members select inline emoji or larger stickers in the composer and custom emoji in reactions. No global/cross-community asset directory, external URLs, SVG, animated assets, DM assets or voice assets. Names are immutable lowercase ASCII letters/digits/underscore, 2–32 characters; a replacement is a new immutable ID. A deleted asset becomes a readable text fallback in old content and cannot silently resolve to a replacement with the same name.

Limits: 128 emoji and64 stickers per community, total64MiB stored bytes; raw emoji256KiB, raw sticker1MiB, decoded input at most1,048,576 pixels/one frame, output WebP at most128×128 or512×512 respectively. Normal scanner, four-process upload admission,10uploads/minute and500MiB/account/day remain authoritative. At most32 custom content tokens including at most3 stickers per message; the existing20-distinct-reaction cap remains. Oversize/animated/malformed data fails explicitly.

## Storage and atomicity

Add community_asset(id,communityId,name,kind,createdAt), unique community/name. Add attachment.assetId nullable unique FK to that record, ON DELETE SET NULL. The asset is community-owned: attachment.uploaderId already uses ON DELETE SET NULL in the actual schema, so account deletion does not remove the library. Community deletion cascades asset records and leaves their attachment objects eligible for normal sweeping. Ordinary attachment delivery remains message-only; a separate private asset route checks current active community membership and suspension state.

Upload uses the existing private staging/scanner/re-encoder/quota path, with static image processing options. After a successful object write, a bounded transaction locks the community, rechecks current manager permission, name/count/byte caps and links only the newly created caller-owned staging row (messageId/channelId/assetId/linkedAt all null). A five-minute upload deadline keeps final linking below the one-hour stale threshold. Lost commit acknowledgements never trigger eager object deletion. Live library attachments do not count as pending unsent uploads, but their bytes remain included in the daily uploader quota.

The sweeper must claim eligible rows atomically before object I/O: no message or asset reference, orphan/old state, set linkedAt as a permanent no-reattach marker, then remove objects and delete only still-unreferenced rows. Final message/asset linking must require linkedAt null and assetId null. Direct FK columns, rather than an unlocked NOT EXISTS alone, keep concurrent link/delete rechecks meaningful. Failure to remove an object leaves the claimed row for retry. Do not hold SQL locks during external storage calls.

## Content and permissions

Stored tokens carry immutable ID plus a safe name/kind snapshot; the composer/editor shows readable shortcodes. A shared bounded parser ignores code spans/fences and URLs, supplies textual projections and remaps archive IDs. Rendering remains React elements, never HTML. Image failure/deletion falls back to a name rather than raw IDs or a broken image. Send/edit/new custom reactions validate live kind/name/ID/community binding inside the existing community-locked transaction, after current SendMessages/rules checks. Removing one's old reaction remains possible after asset deletion.

Resolve message/reaction asset DTOs in batches and bind them to each message channel's community; knowledge of an asset ID never permits cross-community reads. All reply/search/push/account-export projections get readable fallback text. Assets-changed events emit IDs only to already authorized community streams and trigger bounded message/library refresh; open pickers revalidate. Membership loss cannot revoke bytes already downloaded, but future private delivery is denied.

## Portability and privacy

JSON version2 carries bounded asset metadata and readable fallback messages without promising file bytes; retain version1 import. Complete gzip archive version3 includes the entire live library, including unused assets, and its private bytes; retain version2 import. Distinguish message-file versus library-file targets, validate exactly one declared target and unique keys, enforce existing compressed/raw/metadata limits across both, and require a complete checksum-valid stream before commit.

The final importing transaction creates new asset IDs and atomically links owned staging rows, then remaps message tokens only to those fresh destination IDs. Missing/legacy/JSON-only media becomes readable text, never an existing destination asset. Preserve imported author/time attribution. Existing reactions are not exported; do not invent historical reacting accounts or assign reactions to the importer. Asset attribution in personal exports is separate from community ownership; community deletion and asset removal trigger private storage cleanup. Archives remain compressed, not encrypted, and do not replace operator backups.

## Verification

Focused real PostgreSQL/private filesystem cases: concurrent caps/names, foreign-community read/send/react, revoked manager/member/suspended account, malformed/animated/oversized raster and scanner failure, storage ambiguity, sweeper/link interleaving and retry, uploader deletion, community deletion, complete archive remapping/unused library and JSON fallback. Real desktop/mobile manager upload → member picker → rendered emoji/sticker/reaction → deletion fallback → archive import, with console/network, axe, overflow and PNG evidence. Remote lint/types/tests/build/Docker; independent SQL/security/TS review; final exact-head CI, private pre-release backup and deployment readback before any completion claim.
