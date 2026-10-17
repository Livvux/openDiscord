import type { Messages } from "./en";

export const fr: Messages = {
  meta: {
    title: "openDiscord — Les communautés appartiennent à tous",
    description:
      "openDiscord est une plateforme communautaire open source. Utilisez opendiscord.app ou faites tourner la même version sur votre propre serveur.",
  },
  nav: {
    primary: "Principal",
    features: "Fonctionnalités",
    selfHost: "Auto-héberger",
    roadmap: "Feuille de route",
    signIn: "Se connecter",
    join: "Rejoindre l’alpha",
    language: "Langue",
  },
  hero: {
    titleStart: "Les communautés appartiennent à",
    titleAccent: "tous.",
    lead: "openDiscord est une plateforme communautaire open source. Discutez sur opendiscord.app ou faites tourner exactement la même version sur votre propre serveur. Aucun verrouillage, et le chat de base ne sera jamais payant.",
    primary: "Créer une communauté",
    secondary: "L’auto-héberger",
    trust: ["Sans publicité", "Sans traceurs", "Chat jamais payant"],
  },
  mockup: {
    label: "Aperçu du client openDiscord avec communautés, salons et messages",
  },
  media: { play: "Lire la vidéo", pause: "Mettre la vidéo en pause" },
  marquee: {
    label: "Inclus dans la première version",
    items: [
      "Salons textuels", "Voix et vidéo", "Fils", "Rôles", "Exclure et bannir", "Journal d’audit", "Recherche",
      "Réactions", "Double authentification", "Passkeys", "MP chiffrés", "Export des données", "Webhooks", "API publique",
    ],
  },
  features: {
    titleStart: "Tout ce dont une communauté a besoin.",
    titleAccent: "Rien à louer.",
    realtime: {
      title: "En temps réel, mais d’abord enregistré",
      body: "Chaque message est écrit dans PostgreSQL avant que quiconque ne le voie. Après une coupure, le client rattrape son retard depuis la base de données.",
    },
    threads: {
      title: "Des fils qui gardent les salons lisibles",
      body: "Répondez dans un fil au lieu d’inonder le salon. Les réactions, les mentions et la recherche fonctionnent partout de la même façon.",
    },
    invite: {
      title: "Sur invitation par défaut",
      body: "Les personnes extérieures ne peuvent ni lire, ni s’abonner, ni même découvrir une communauté. Le serveur applique cette règle et des tests la couvrent.",
    },
    moderation: {
      title: "Modération intégrée",
      body: "Des rôles avec une hiérarchie claire, exclusions et bannissements motivés, un journal d’audit et des limites de débit dès le premier jour.",
    },
    data: {
      title: "Vos données, votre choix",
      body: "Exportez tout ce que vous avez écrit ou supprimez votre compte en un clic. Pas de dark patterns, pas de pistage publicitaire.",
    },
    encryption: {
      title: "Honnêtes sur le chiffrement",
      body: "Les messages privés sont chiffrés de bout en bout entre appareils vérifiés. Le texte et la voix des communautés ne le sont pas. L’intégration n’a pas encore fait l’objet d’un audit de sécurité indépendant.",
      dms: "Messages privés",
      community: "Salons de communauté",
      yes: "De bout en bout",
      no: "Côté serveur",
    },
  },
  selfHost: {
    titleStart: "Un seul fichier compose.",
    titleAccent: "Votre serveur. Vos règles.",
    lead: "L’instance officielle et la vôtre utilisent la même image. Pointez un domaine vers un petit VPS, définissez deux secrets et vous avez un serveur communautaire avec des sauvegardes que vous maîtrisez.",
    principles: [
      { title: "Aucune dépendance envers nous", body: "Une instance auto-hébergée ne contacte jamais la maison mère : pas de connexion partagée, pas de compte de paiement, pas besoin de Cloudflare." },
      { title: "Le même cœur partout", body: "opendiscord.app fait tourner la version publique. L’hébergement est un confort, pas un verrou de fonctionnalités." },
      { title: "L’argent n’achète pas de pouvoirs de modération", body: "Le parrainage finance le développement et les serveurs. Il n’accorde jamais de droits au sein d’une communauté." },
    ],
    services: [
      { name: "postgres", desc: "La source de vérité de chaque message" },
      { name: "migrate", desc: "Applique les changements de schéma, puis s’arrête" },
      { name: "web", desc: "App Next.js, API et authentification" },
      { name: "caddy", desc: "HTTPS automatique pour votre domaine" },
    ],
    panelLabel: "Façons de faire tourner openDiscord",
    tabSelfHost: "Auto-hébergé",
    tabHosted: "Hébergé",
    envNote: "# définir DOMAIN + secrets",
    running: "en marche",
    hosted: {
      account: "Créez un compte sur opendiscord.app",
      community: "Fondez une communauté",
      communityNote: "# salons, rôles, invitations",
      invite: "Partagez un lien d’invitation",
      same: "La même version open source",
      sameNote: "aucun verrouillage",
      move: "Passez sur votre propre serveur à tout moment",
    },
  },
  roadmap: {
    titleStart: "Une première version modeste.",
    titleAccent: "Une feuille de route publique.",
    stages: [
      {
        label: "Maintenant",
        title: "Alpha fermée",
        items: ["Salons privés, rôles, modération", "Mentions, fils, recherche, réactions", "Voix, vidéo et partage d’écran", "Bots, webhooks, API publique", "MP chiffrés avec vérification des appareils", "Recours, règles et durées de conservation", "Emojis et stickers personnalisés", "Salons publics et découverte"],
      },
      {
        label: "Ensuite",
        title: "Plus proches",
        items: ["Chiffrement de la voix et TURN", "Audit de sécurité indépendant", "Validation sur appareils physiques", "Peaufiner l’auto-hébergement"],
      },
      {
        label: "Plus tard",
        title: "Applis et groupes",
        items: ["Applications natives", "MP de groupe et appels en MP"],
      },
    ],
  },
  footer: {
    titleStart: "Ramenez votre communauté",
    titleAccent: "à la maison.",
    lead: "Rejoignez l’alpha sur invitation, ou découvrez ce que coûte le fonctionnement de l’instance hébergée.",
    join: "Rejoindre l’alpha",
    funding: "Financement et coûts de fonctionnement",
    tagline: "Esprits ouverts. Plus brillants ensemble.",
    nav: "Pied de page",
    discover: "Découvrir les salons publics",
    privacy: "Confidentialité",
    terms: "Conditions",
    guidelines: "Règles",
    imprint: "Mentions légales",
    signIn: "Se connecter",
  },
};
