/** Limits shared by client and server. */
export const MESSAGE_MAX_LENGTH = 4000;

/** Image attachments: decoded and re-encoded server-side, so the type list is a first filter only. */
export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

/** Other files are stored unchanged and only ever served as downloads. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
