/** The first accounts on an instance get Early Supporter. */
export const EARLY_SUPPORTER_LIMIT = 100;

/** Profile badges in display order. */
export const BADGES = [
  { id: "system_admin", label: "System Admin", hint: "Administers this instance." },
  { id: "hypesquad", label: "HypeSquad", hint: "Granted with an approved HypeSquad application." },
  { id: "early_supporter", label: "Early Supporter", hint: `One of the first ${EARLY_SUPPORTER_LIMIT} accounts on this instance.` },
  { id: "community_founder", label: "Community Founder", hint: "Owns a community." },
] as const;
export type BadgeId = (typeof BADGES)[number]["id"];
