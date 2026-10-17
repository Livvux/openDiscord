import type { Messages } from "./en";

export const de: Messages = {
  meta: {
    title: "openDiscord — Communities gehören allen",
    description:
      "openDiscord ist eine Open-Source-Plattform für Communities. Nutze opendiscord.app oder betreibe dasselbe Release auf deinem eigenen Server.",
  },
  nav: {
    primary: "Hauptnavigation",
    features: "Funktionen",
    selfHost: "Selbst hosten",
    roadmap: "Roadmap",
    signIn: "Anmelden",
    join: "Zur Beta",
    language: "Sprache",
  },
  hero: {
    titleStart: "Communities gehören",
    titleAccent: "allen.",
    lead: "openDiscord ist eine Open-Source-Plattform für Communities. Chatte auf opendiscord.app oder betreibe exakt dasselbe Release auf deinem eigenen Server. Kein Lock-in, und einfacher Chat landet nie hinter einer Paywall.",
    primary: "Community starten",
    secondary: "Selbst hosten",
    trust: ["Keine Werbung", "Keine Tracker", "Chat ohne Paywall"],
  },
  mockup: {
    label: "Vorschau des openDiscord-Clients mit Communities, Kanälen und Nachrichten",
  },
  media: { play: "Video abspielen", pause: "Video pausieren" },
  marquee: {
    label: "Im ersten Release enthalten",
    items: [
      "Textkanäle", "Sprache & Video", "Threads", "Rollen", "Kick & Ban", "Audit-Log", "Suche",
      "Reaktionen", "Zwei-Faktor-Login", "Passkeys", "Verschlüsselte DMs", "Datenexport", "Webhooks", "Öffentliche API",
    ],
  },
  features: {
    titleStart: "Alles, was eine Community braucht.",
    titleAccent: "Nichts, was sie mieten muss.",
    realtime: {
      title: "Echtzeit, aber zuerst gespeichert",
      body: "Jede Nachricht landet in PostgreSQL, bevor sie jemand sieht. Nach einem Verbindungsabbruch holt der Client alles aus der Datenbank nach.",
    },
    threads: {
      title: "Threads halten Kanäle lesbar",
      body: "Antworte im Thread, statt den Kanal zu fluten. Reaktionen, Erwähnungen und Suche funktionieren überall gleich.",
    },
    invite: {
      title: "Standardmäßig nur mit Einladung",
      body: "Außenstehende können eine Community weder lesen noch abonnieren oder überhaupt finden. Der Server erzwingt diese Regel, Tests sichern sie ab.",
    },
    moderation: {
      title: "Moderation eingebaut",
      body: "Rollen mit klarer Hierarchie, Kick und Ban mit Begründung, ein Audit-Log und Rate-Limits ab dem ersten Tag.",
    },
    data: {
      title: "Deine Daten, deine Entscheidung",
      body: "Exportiere alles, was du geschrieben hast, oder lösche dein Konto mit einem Klick. Keine Dark Patterns, kein Werbe-Tracking.",
    },
    encryption: {
      title: "Ehrlich bei Verschlüsselung",
      body: "Direktnachrichten sind zwischen verifizierten Geräten Ende-zu-Ende-verschlüsselt. Community-Text und Sprache sind es nicht. Die Integration wurde noch nicht unabhängig geprüft.",
      dms: "Direktnachrichten",
      community: "Community-Kanäle",
      yes: "Ende-zu-Ende",
      no: "Serverseitig",
    },
  },
  selfHost: {
    titleStart: "Eine Compose-Datei.",
    titleAccent: "Dein Server. Deine Regeln.",
    lead: "Die offizielle Instanz und deine Instanz nutzen dasselbe Image. Richte eine Domain auf einen kleinen VPS, setze zwei Secrets, und du hast einen Community-Server mit Backups unter deiner Kontrolle.",
    principles: [
      { title: "Keine Abhängigkeit von uns", body: "Eine selbst gehostete Instanz telefoniert nie nach Hause: kein gemeinsamer Login, kein Zahlungskonto, kein Cloudflare nötig." },
      { title: "Überall derselbe Kern", body: "opendiscord.app läuft mit dem öffentlichen Release. Hosting ist Komfort, keine Funktionssperre." },
      { title: "Geld kauft keine Mod-Rechte", body: "Sponsoring finanziert Entwicklung und Server. Es verleiht nie Rechte innerhalb einer Community." },
    ],
    services: [
      { name: "postgres", desc: "Die Quelle jeder Nachricht" },
      { name: "migrate", desc: "Spielt Schemaänderungen ein und beendet sich" },
      { name: "web", desc: "Next.js-App, API und Auth" },
      { name: "caddy", desc: "Automatisches HTTPS für deine Domain" },
    ],
    panelLabel: "Wege, openDiscord zu betreiben",
    tabSelfHost: "Selbst hosten",
    tabHosted: "Gehostet",
    envNote: "# DOMAIN + Secrets setzen",
    running: "läuft",
    hosted: {
      account: "Konto auf opendiscord.app anlegen",
      community: "Community gründen",
      communityNote: "# Kanäle, Rollen, Einladungen",
      invite: "Einladungslink teilen",
      same: "Dasselbe Open-Source-Release",
      sameNote: "kein Lock-in",
      move: "Jederzeit auf den eigenen Server umziehen",
    },
  },
  roadmap: {
    titleStart: "Kleines erstes Release.",
    titleAccent: "Öffentliche Roadmap.",
    stages: [
      {
        label: "Jetzt",
        title: "Geschlossene Alpha",
        items: ["Private Kanäle, Rollen, Moderation", "Erwähnungen, Threads, Suche, Reaktionen", "Sprache, Video und Bildschirmfreigabe", "Bots, Webhooks, öffentliche API", "Verschlüsselte DMs mit Geräteverifizierung", "Einsprüche, Regeln und Aufbewahrungsfristen"],
      },
      {
        label: "Als Nächstes",
        title: "Näher zusammen",
        items: ["Sprachverschlüsselung und TURN", "Unabhängiges Sicherheitsreview", "Abnahme auf echten Geräten", "Feinschliff fürs Selbsthosten"],
      },
      {
        label: "Später",
        title: "Sprache und mehr",
        items: ["Eigene Emojis und Sticker", "Native Apps", "Optionale öffentliche Kanäle", "Community-Verzeichnis"],
      },
    ],
  },
  footer: {
    titleStart: "Hol deine Community",
    titleAccent: "nach Hause.",
    lead: "Mach mit bei der Beta mit Einladung – oder sieh dir an, was der Betrieb der gehosteten Instanz kostet.",
    join: "Zur Beta",
    funding: "Finanzierung und Betriebskosten",
    tagline: "Offen denken. Gemeinsam heller.",
    nav: "Fußzeile",
    discover: "Öffentliche Kanäle entdecken",
    privacy: "Datenschutz",
    terms: "Nutzungsbedingungen",
    guidelines: "Richtlinien",
    imprint: "Impressum",
    signIn: "Anmelden",
  },
};
