export const en = {
  meta: {
    title: "openDiscord — Communities belong to everyone",
    description:
      "openDiscord is an open-source community platform. Use opendiscord.app or run the same release on your own server.",
  },
  nav: {
    primary: "Primary",
    features: "Features",
    selfHost: "Self-host",
    roadmap: "Roadmap",
    signIn: "Sign in",
    join: "Join the alpha",
    language: "Language",
  },
  hero: {
    titleStart: "Communities belong to",
    titleAccent: "everyone.",
    lead: "openDiscord is an open-source community platform. Chat on opendiscord.app, or run the exact same release on your own server. No lock-in, and basic chat is never behind a paywall.",
    primary: "Start a community",
    secondary: "Self-host it",
    trust: ["No ads", "No trackers", "Chat is never paywalled"],
  },
  mockup: {
    label: "Preview of the opendiscord chat client with communities, channels and messages",
  },
  media: { play: "Play video", pause: "Pause video" },
  marquee: {
    label: "Included in the first release",
    items: [
      "Text channels", "Voice & video", "Threads", "Roles", "Kick & ban", "Audit log", "Search",
      "Reactions", "Two-factor auth", "Passkeys", "Encrypted DMs", "Data export", "Webhooks", "Public API",
    ],
  },
  features: {
    titleStart: "Everything a community needs.",
    titleAccent: "Nothing it has to rent.",
    realtime: {
      title: "Real-time, written down first",
      body: "Every message lands in PostgreSQL before anyone sees it. After a dropped connection, the client catches up from the database.",
    },
    threads: {
      title: "Threads that keep channels readable",
      body: "Reply in a thread instead of flooding the channel. Reactions, mentions and search work the same everywhere.",
    },
    invite: {
      title: "Invite-only by default",
      body: "Outsiders can't read, subscribe to or even discover a community. That rule is enforced on the server and covered by tests.",
    },
    moderation: {
      title: "Moderation built in",
      body: "Roles with a clear hierarchy, kick and ban with reasons, an audit log and rate limits from day one.",
    },
    data: {
      title: "Your data, your call",
      body: "Export everything you've written or delete your account in a click. No dark patterns, no ad tracking.",
    },
    encryption: {
      title: "Honest about encryption",
      body: "1:1 and group DMs, including their attachments, are end-to-end encrypted between verified devices. Voice media uses end-to-end encryption on supported browsers. Community text and its attachments remain readable by the operator. The integration has not had an independent security audit.",
      dms: "Direct messages",
      community: "Community text",
      yes: "End-to-end",
      no: "Server-side",
    },
  },
  selfHost: {
    titleStart: "One compose file.",
    titleAccent: "Your server. Your rules.",
    lead: "The official instance and your instance run the same image. Point a domain at a small VPS, set two secrets and you have a community server with backups you control.",
    principles: [
      { title: "No dependency on us", body: "A self-hosted instance never calls home: no shared login, no payment account, no Cloudflare required." },
      { title: "Same core everywhere", body: "opendiscord.app runs the public release. Hosting is a convenience, not a feature gate." },
      { title: "Money can't buy mod powers", body: "Sponsorship funds development and servers. It never grants rights inside a community." },
    ],
    services: [
      { name: "postgres", desc: "Source of truth for every message" },
      { name: "migrate", desc: "Applies schema changes, then exits" },
      { name: "web", desc: "Next.js app, API and auth" },
      { name: "caddy", desc: "Automatic HTTPS for your domain" },
    ],
    panelLabel: "Ways to run opendiscord",
    tabSelfHost: "Self-host",
    tabHosted: "Hosted",
    envNote: "# set DOMAIN + secrets",
    running: "running",
    hosted: {
      account: "Create an account on opendiscord.app",
      community: "Start a community",
      communityNote: "# channels, roles, invites",
      invite: "Share an invite link",
      same: "Same open-source release",
      sameNote: "no lock-in",
      move: "Move to your own server any time",
    },
  },
  roadmap: {
    titleStart: "Small first release.",
    titleAccent: "Public roadmap.",
    stages: [
      {
        label: "Now",
        title: "Closed alpha",
        items: ["Private channels, roles, moderation", "Mentions, threads, search, reactions", "Voice, video and screen sharing", "Bots, webhooks, public API", "Encrypted 1:1/group DMs and DM calls", "Appeals, rules and retention controls", "Custom emoji and stickers", "Public channels and discovery"],
      },
      {
        label: "Next",
        title: "Closer together",
        items: ["Real-device Voice and TURN acceptance", "Independent security review", "Physical-device acceptance", "Self-hosting polish"],
      },
      {
        label: "Later",
        title: "Native clients",
        items: ["Native apps"],
      },
    ],
  },
  footer: {
    titleStart: "Bring your community",
    titleAccent: "home.",
    lead: "Join the invite-only alpha, or see what it costs to run the hosted instance.",
    join: "Join the alpha",
    funding: "Funding and running costs",
    tagline: "Open minds. Brighter together.",
    nav: "Footer",
    discover: "Discover public channels",
    privacy: "Privacy",
    terms: "Terms",
    guidelines: "Guidelines",
    imprint: "Imprint",
    signIn: "Sign in",
  },
};

export type Messages = typeof en;
