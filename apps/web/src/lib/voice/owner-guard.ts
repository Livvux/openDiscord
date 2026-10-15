/** Runtime capabilities are issued only while the independent browser Web Lock is held. */
export type VoiceOwnerGuard = { readonly accountId: string };
type Held = { consumed: boolean; release: () => Promise<void>; active: boolean };
const issued = new WeakMap<VoiceOwnerGuard, Held>();
export async function acquireVoiceOwnerGuard(accountId: string): Promise<VoiceOwnerGuard> {
  if (!accountId || !globalThis.navigator?.locks) throw new Error("Voice ownership unavailable.");
  let acquired!: (guard: VoiceOwnerGuard) => void;
  let rejected!: (error: unknown) => void;
  const result = new Promise<VoiceOwnerGuard>((resolve, reject) => { acquired = resolve; rejected = reject; });
  const finished = navigator.locks.request(`opendiscord.voice:${accountId}`, { ifAvailable: true }, async lock => {
    if (!lock) { rejected(new Error("Voice owner already held.")); return; }
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const guard = Object.freeze({ accountId });
    issued.set(guard, { consumed: false, release: async () => { release(); await finished; }, active: true });
    acquired(guard);
    await held;
  }).catch(rejected);
  return result;
}
/** Internal runtime validation; a structural TypeScript lookalike cannot acquire ownership. */
export function consumeVoiceOwnerGuard(guard: VoiceOwnerGuard, accountId: string): () => Promise<void> {
  const state = issued.get(guard);
  if (!state?.active || state.consumed || guard.accountId !== accountId) throw new Error("Invalid voice ownership capability.");
  state.consumed = true;
  return async () => { if (state.active) { state.active = false; issued.delete(guard); await state.release(); } };
}
/** Release an acquired capability when enrollment is abandoned before constructing an owner. */
export async function releaseUnusedVoiceOwnerGuard(guard: VoiceOwnerGuard): Promise<void> {
  const state = issued.get(guard);
  if (state?.active && !state.consumed) { state.active = false; issued.delete(guard); await state.release(); }
}
