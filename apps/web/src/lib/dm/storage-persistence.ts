export type StoragePersistence = "persisted" | "denied" | "unsupported";
type PersistApi = Partial<Pick<StorageManager, "persisted" | "persist">>;

/** Asks the browser not to evict this origin's storage, where the DM device keys live. */
export async function requestPersistentStorage(storage: PersistApi | undefined): Promise<StoragePersistence> {
  if (!storage?.persist) return "unsupported";
  try {
    if (await storage.persisted?.()) return "persisted";
    return (await storage.persist()) ? "persisted" : "denied";
  } catch {
    return "denied";
  }
}

let requested: Promise<StoragePersistence> | undefined;
/** Once per page load, after the DM device is enrolled. */
export function persistDmStorage(): Promise<StoragePersistence> {
  requested ??= requestPersistentStorage(typeof navigator === "undefined" ? undefined : navigator.storage);
  return requested;
}

/** iOS Safari tab (not a Home Screen app): Safari may delete site data after 7 days without a visit. */
export function iosBrowserTab(): { ios: boolean; standalone: boolean } {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  return { ios, standalone };
}

export function storageHint(state: StoragePersistence, device: { ios: boolean; standalone: boolean }): string | null {
  if (state === "persisted") return null;
  const install = device.ios && !device.standalone
    ? " On iPhone and iPad, Safari can clear it after about a week without a visit; install openDiscord with Share → Add to Home Screen to keep it."
    : "";
  return `This browser may clear its saved data, including the keys that read your private messages.${install} Create an encrypted recovery backup below and keep the file somewhere safe, so you can restore your messages if that happens.`;
}
