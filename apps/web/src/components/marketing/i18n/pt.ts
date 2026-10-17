import type { Messages } from "./en";

export const pt: Messages = {
  meta: {
    title: "openDiscord — Comunidades pertencem a todos",
    description:
      "openDiscord é uma plataforma de comunidades de código aberto. Use opendiscord.app ou rode a mesma versão no seu próprio servidor.",
  },
  nav: {
    primary: "Principal",
    features: "Recursos",
    selfHost: "Auto-hospedar",
    roadmap: "Roadmap",
    signIn: "Entrar",
    join: "Entrar na beta",
    language: "Idioma",
  },
  hero: {
    titleStart: "Comunidades pertencem a",
    titleAccent: "todos.",
    lead: "openDiscord é uma plataforma de comunidades de código aberto. Converse em opendiscord.app ou rode exatamente a mesma versão no seu próprio servidor. Sem aprisionamento, e o chat básico nunca fica atrás de um paywall.",
    primary: "Crie uma comunidade",
    secondary: "Auto-hospede",
    trust: ["Sem anúncios", "Sem rastreadores", "Chat sem paywall"],
  },
  mockup: {
    label: "Prévia do cliente openDiscord com comunidades, canais e mensagens",
  },
  media: { play: "Reproduzir vídeo", pause: "Pausar vídeo" },
  marquee: {
    label: "Incluído na primeira versão",
    items: [
      "Canais de texto", "Voz e vídeo", "Threads", "Cargos", "Expulsar e banir", "Log de auditoria", "Busca",
      "Reações", "Dois fatores", "Passkeys", "DMs criptografadas", "Exportar dados", "Webhooks", "API pública",
    ],
  },
  features: {
    titleStart: "Tudo o que uma comunidade precisa.",
    titleAccent: "Nada que ela precise alugar.",
    realtime: {
      title: "Tempo real, mas gravado primeiro",
      body: "Cada mensagem é salva no PostgreSQL antes de alguém vê-la. Depois de uma queda de conexão, o cliente recupera tudo a partir do banco de dados.",
    },
    threads: {
      title: "Threads que mantêm os canais legíveis",
      body: "Responda em uma thread em vez de inundar o canal. Reações, menções e busca funcionam do mesmo jeito em todo lugar.",
    },
    invite: {
      title: "Só com convite, por padrão",
      body: "Quem é de fora não consegue ler, assinar nem sequer descobrir uma comunidade. O servidor aplica essa regra e testes a garantem.",
    },
    moderation: {
      title: "Moderação embutida",
      body: "Cargos com hierarquia clara, expulsões e banimentos com motivo, log de auditoria e limites de taxa desde o primeiro dia.",
    },
    data: {
      title: "Seus dados, sua decisão",
      body: "Exporte tudo o que você escreveu ou exclua sua conta com um clique. Sem dark patterns, sem rastreamento de anúncios.",
    },
    encryption: {
      title: "Honestos sobre criptografia",
      body: "Mensagens diretas são criptografadas de ponta a ponta entre dispositivos verificados. Texto e voz das comunidades não são. A integração ainda não passou por uma auditoria de segurança independente.",
      dms: "Mensagens diretas",
      community: "Canais da comunidade",
      yes: "Ponta a ponta",
      no: "No servidor",
    },
  },
  selfHost: {
    titleStart: "Um arquivo compose.",
    titleAccent: "Seu servidor. Suas regras.",
    lead: "A instância oficial e a sua rodam a mesma imagem. Aponte um domínio para uma VPS pequena, defina dois segredos e você terá um servidor de comunidade com backups sob seu controle.",
    principles: [
      { title: "Sem depender de nós", body: "Uma instância auto-hospedada nunca liga para casa: sem login compartilhado, sem conta de pagamento, sem precisar de Cloudflare." },
      { title: "O mesmo núcleo em todo lugar", body: "opendiscord.app roda a versão pública. Hospedagem é conveniência, não bloqueio de recursos." },
      { title: "Dinheiro não compra poder de moderação", body: "Patrocínios financiam o desenvolvimento e os servidores. Nunca concedem direitos dentro de uma comunidade." },
    ],
    services: [
      { name: "postgres", desc: "A fonte da verdade de cada mensagem" },
      { name: "migrate", desc: "Aplica mudanças de schema e encerra" },
      { name: "web", desc: "App Next.js, API e autenticação" },
      { name: "caddy", desc: "HTTPS automático para o seu domínio" },
    ],
    panelLabel: "Formas de rodar o openDiscord",
    tabSelfHost: "Auto-hospedado",
    tabHosted: "Hospedado",
    envNote: "# defina DOMAIN + segredos",
    running: "rodando",
    hosted: {
      account: "Crie uma conta em opendiscord.app",
      community: "Funde uma comunidade",
      communityNote: "# canais, cargos, convites",
      invite: "Compartilhe um link de convite",
      same: "A mesma versão de código aberto",
      sameNote: "sem aprisionamento",
      move: "Mude para o seu próprio servidor quando quiser",
    },
  },
  roadmap: {
    titleStart: "Primeira versão enxuta.",
    titleAccent: "Roadmap público.",
    stages: [
      {
        label: "Agora",
        title: "Alfa fechado",
        items: ["Canais privados, cargos, moderação", "Menções, threads, busca, reações", "Voz, vídeo e compartilhamento de tela", "Bots, webhooks, API pública", "DMs criptografadas com verificação de dispositivos", "Recursos, regras e controles de retenção"],
      },
      {
        label: "Em seguida",
        title: "Mais perto",
        items: ["Criptografia de voz e TURN", "Revisão de segurança independente", "Validação em dispositivos físicos", "Polimento da auto-hospedagem"],
      },
      {
        label: "Depois",
        title: "Voz e além",
        items: ["Emojis e figurinhas próprios", "Apps nativos", "Canais públicos opcionais", "Descoberta de comunidades"],
      },
    ],
  },
  footer: {
    titleStart: "Traga sua comunidade",
    titleAccent: "para casa.",
    lead: "Entre na beta por convite ou veja quanto custa manter a instância hospedada.",
    join: "Entrar na beta",
    funding: "Financiamento e custos",
    tagline: "Mentes abertas. Mais brilhantes juntos.",
    nav: "Rodapé",
    discover: "Descubra canais públicos",
    privacy: "Privacidade",
    terms: "Termos",
    guidelines: "Diretrizes",
    imprint: "Aviso legal",
    signIn: "Entrar",
  },
};
