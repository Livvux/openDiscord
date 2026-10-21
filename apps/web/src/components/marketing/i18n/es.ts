import type { Messages } from "./en";

export const es: Messages = {
  meta: {
    title: "openDiscord — Las comunidades son de todos",
    description:
      "openDiscord es una plataforma de comunidades de código abierto. Usa opendiscord.app o ejecuta la misma versión en tu propio servidor.",
  },
  nav: {
    primary: "Principal",
    features: "Funciones",
    selfHost: "Autoalojar",
    roadmap: "Hoja de ruta",
    signIn: "Iniciar sesión",
    join: "Únete a la alfa cerrada",
    language: "Idioma",
  },
  hero: {
    titleStart: "Las comunidades son de",
    titleAccent: "todos.",
    lead: "openDiscord es una plataforma de comunidades de código abierto. Chatea en opendiscord.app o ejecuta exactamente la misma versión en tu propio servidor. Sin ataduras, y el chat básico nunca estará detrás de un muro de pago.",
    primary: "Crea una comunidad",
    secondary: "Autoalójalo",
    trust: ["Sin anuncios", "Sin rastreadores", "Chat sin muro de pago"],
  },
  mockup: {
    label: "Vista previa del cliente de openDiscord con comunidades, canales y mensajes",
  },
  media: { play: "Reproducir vídeo", pause: "Pausar vídeo" },
  marquee: {
    label: "Incluido en la primera versión",
    items: [
      "Canales de texto", "Voz y vídeo", "Hilos", "Roles", "Expulsar y banear", "Registro de auditoría", "Búsqueda",
      "Reacciones", "Doble factor", "Passkeys", "MD cifrados", "Exportar datos", "Webhooks", "API pública",
    ],
  },
  features: {
    titleStart: "Todo lo que una comunidad necesita.",
    titleAccent: "Nada que tenga que alquilar.",
    realtime: {
      title: "Tiempo real, pero primero por escrito",
      body: "Cada mensaje se guarda en PostgreSQL antes de que nadie lo vea. Tras perder la conexión, el cliente se pone al día desde la base de datos.",
    },
    threads: {
      title: "Hilos que mantienen los canales legibles",
      body: "Responde en un hilo en lugar de inundar el canal. Las reacciones, las menciones y la búsqueda funcionan igual en todas partes.",
    },
    invite: {
      title: "Solo con invitación por defecto",
      body: "Quien no es miembro no puede leer, suscribirse ni siquiera descubrir una comunidad. El servidor aplica esta regla y los tests la cubren.",
    },
    moderation: {
      title: "Moderación integrada",
      body: "Roles con una jerarquía clara, expulsiones y baneos con motivo, registro de auditoría y límites de frecuencia desde el primer día.",
    },
    data: {
      title: "Tus datos, tu decisión",
      body: "Exporta todo lo que has escrito o elimina tu cuenta con un clic. Sin patrones oscuros ni rastreo publicitario.",
    },
    encryption: {
      title: "Honestos con el cifrado",
      body: "Los mensajes directos individuales y de grupo, incluidos sus archivos adjuntos, están cifrados de extremo a extremo entre dispositivos verificados. La voz y el vídeo usan cifrado de extremo a extremo en navegadores compatibles. El operador puede leer el texto de las comunidades y sus archivos adjuntos. La integración aún no ha pasado una auditoría de seguridad independiente.",
      dms: "Mensajes directos",
      community: "Texto de comunidad",
      yes: "Extremo a extremo",
      no: "En el servidor",
    },
  },
  selfHost: {
    titleStart: "Un archivo compose.",
    titleAccent: "Tu servidor. Tus reglas.",
    lead: "La instancia oficial y la tuya ejecutan la misma imagen. Apunta un dominio a un VPS pequeño, define dos secretos y tendrás un servidor de comunidad con copias de seguridad bajo tu control.",
    principles: [
      { title: "Sin depender de nosotros", body: "Una instancia autoalojada nunca llama a casa: sin inicio de sesión compartido, sin cuenta de pago, sin necesidad de Cloudflare." },
      { title: "El mismo núcleo en todas partes", body: "opendiscord.app ejecuta la versión pública. El alojamiento es una comodidad, no un bloqueo de funciones." },
      { title: "El dinero no compra poderes de moderación", body: "El patrocinio financia el desarrollo y los servidores. Nunca otorga derechos dentro de una comunidad." },
    ],
    services: [
      { name: "postgres", desc: "La fuente de verdad de cada mensaje" },
      { name: "migrate", desc: "Aplica cambios de esquema y termina" },
      { name: "web", desc: "App Next.js, API y autenticación" },
      { name: "caddy", desc: "HTTPS automático para tu dominio" },
    ],
    panelLabel: "Formas de ejecutar openDiscord",
    tabSelfHost: "Autoalojado",
    tabHosted: "Alojado",
    envNote: "# define DOMAIN + secretos",
    running: "en marcha",
    hosted: {
      account: "Crea una cuenta en opendiscord.app",
      community: "Funda una comunidad",
      communityNote: "# canales, roles, invitaciones",
      invite: "Comparte un enlace de invitación",
      same: "La misma versión de código abierto",
      sameNote: "sin ataduras",
      move: "Muévete a tu propio servidor cuando quieras",
    },
  },
  roadmap: {
    titleStart: "Primera versión pequeña.",
    titleAccent: "Hoja de ruta pública.",
    stages: [
      {
        label: "Ahora",
        title: "Alfa cerrada",
        items: ["Canales privados, roles, moderación", "Menciones, hilos, búsqueda, reacciones", "Voz, vídeo y compartir pantalla", "Bots, webhooks, API pública", "MD individuales y grupales cifrados y llamadas por MD", "Apelaciones, normas y controles de retención", "Emojis y stickers propios", "Canales públicos y descubrimiento"],
      },
      {
        label: "Después",
        title: "Más cerca",
        items: ["Pruebas de voz y TURN en dispositivos reales", "Revisión de seguridad independiente", "Pruebas en dispositivos físicos", "Pulir el autoalojamiento"],
      },
      {
        label: "Más adelante",
        title: "Aplicaciones nativas",
        items: ["Apps nativas"],
      },
    ],
  },
  footer: {
    titleStart: "Lleva tu comunidad",
    titleAccent: "a casa.",
    lead: "Únete a la alfa cerrada o mira lo que cuesta mantener la instancia alojada.",
    join: "Únete a la alfa cerrada",
    funding: "Financiación y costes",
    tagline: "Mentes abiertas. Más brillantes juntos.",
    nav: "Pie de página",
    discover: "Descubre canales públicos",
    privacy: "Privacidad",
    terms: "Términos",
    guidelines: "Normas",
    imprint: "Aviso legal",
    signIn: "Iniciar sesión",
  },
};
