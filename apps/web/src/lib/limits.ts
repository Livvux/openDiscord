/** Limits shared by client and server. */
export const MESSAGE_MAX_LENGTH = 4000;

/** Image attachments: decoded and re-encoded server-side, so the type list is a first filter only. */
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/** Profile pictures: the client uploads a cropped square at this size; the server re-encodes it. */
export const AVATAR_DIMENSION = 256;
export const AVATAR_RAW_BYTES = 2 * 1024 * 1024;

/** Other files are stored unchanged and only ever served as downloads. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Complete community archives fail explicitly instead of silently omitting files over these caps. */
export const MAX_ARCHIVE_ATTACHMENTS = 4096;
export const MAX_ARCHIVE_MEDIA_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVE_METADATA_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_COMPRESSED_BYTES = 384 * 1024 * 1024;
