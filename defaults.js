export const MODULES = {
  antiSpam: "Anti-Spam",
  antiFlood: "Anti-Flood",
  mentionSpam: "Spam de Menções",
  autoMod: "AutoMod",
  antiBot: "Anti-Bot",
  antiRaid: "Anti-Raid",
  antiNuke: "Anti-Nuke",
  antiLink: "Anti-Link"
};

const common = (publicMessage, dmMessage) => ({
  enabled: false,
  watchChannelIds: [],
  publicChannelId: null,
  logChannelId: null,
  staffChannelId: null,
  staffRoleIds: [],
  logEmbedTitle: "Registro • {type}",
  logEmbedDescription: "**Módulo:** {module}\n**Servidor:** {server}",
  logEmbedColor: "#5865F2",
  logEmbedFooter: "Futaba Sakura • Registros",
  logEmbedAuthor: "",
  logEmbedAuthorIconUrl: null,
  logEmbedFooterIconUrl: null,
  logEmbedImageUrl: null,
  logEmbedThumbnailUrl: null,
  logEmbedTimestamp: true,
  logEmbedIncludeDefaultFields: true,
  logEmbedFields: [],
  staffEmbedTitle: "Alerta de moderação • {type}",
  staffEmbedDescription: "**Módulo:** {module}\n**Servidor:** {server}",
  staffEmbedColor: "#D94A62",
  staffEmbedFooter: "Futaba Sakura • Equipe",
  staffEmbedAuthor: "",
  staffEmbedAuthorIconUrl: null,
  staffEmbedFooterIconUrl: null,
  staffEmbedImageUrl: null,
  staffEmbedThumbnailUrl: null,
  staffEmbedTimestamp: true,
  staffEmbedIncludeDefaultFields: true,
  staffEmbedFields: [],
  publicMessage,
  dmMessage,
  bannerUrl: null
});

export function createDefaultGuildConfig() {
  return {
    displayName: "Futaba Sakura",
    general: {
      logChannelId: null,
      defaultClearCount: 50,
      prefix: "!",
      punishmentEmbed: {
        title: "⚖️ O veredito foi declarado!",
        description: "O juiz declarou que a sentença é:",
        color: "#FF963F",
        footer: "POOL Party Moderation • Tribunal de Fontaine ⚖️",
        author: "Tribunal de Fontaine",
        authorIconUrl: null,
        footerIconUrl: null,
        imageUrl: null,
        thumbnailUrl: null,
        timestamp: true,
        includeDefaultFields: true,
        fields: []
      }
    },
    moderationHistory: [],
    channelLocks: {},
    appeals: {
      active: false,
      alertChannelId: null,
      viewRoleIds: [],
      assumeRoleIds: [],
      decideRoleIds: [],
      manageRoleIds: [],
      maxActivePerMember: 3,
      maxAttachments: 8,
      maxTotalAttachmentBytes: 3145728,
      notifyMemberOnStaffMessage: true,
      notifyStaffOnMemberMessage: true,
      openingMessage: "Sua apelação foi recebida e está aguardando atendimento.",
      acceptedMessage: "Sua apelação foi aceita. A equipe registrou a decisão e informará separadamente qualquer ação de moderação necessária.",
      rejectedMessage: "Sua apelação foi rejeitada. Consulte a justificativa registrada no atendimento."
    },
    antiSpam: {
      ...common(
        "<@{user}> suas mensagens foram identificadas como spam. A ocorrência foi registrada e a medida configurada foi processada; revise as regras do servidor.",
        "Suas mensagens no canal #{channel} foram identificadas como spam. Evite repetir mensagens, emojis, stickers ou imagens."
      ),
      repeats: 3,
      repeatWindowSeconds: 8,
      emojiLimit: 8,
      deleteMessage: true,
      muteDurationSeconds: 600,
      deleteDelaySeconds: 1,
      noticeDeleteDelaySeconds: 5
    },
    antiFlood: {
      ...common(
        "<@{user}> você enviou mensagens rápido demais. A ocorrência foi registrada; diminua o ritmo para evitar novas medidas.",
        "Você enviou mensagens em excesso no canal #{channel}. Aguarde um pouco antes de continuar."
      ),
      messageLimit: 7,
      windowSeconds: 5,
      deleteTriggerMessage: true,
      muteDurationSeconds: 600,
      deleteDelaySeconds: 1,
      noticeDeleteDelaySeconds: 5
    },
    mentionSpam: {
      ...common(
        "<@{user}> suas mensagens excederam o limite de menções permitido no período.",
        "Suas mensagens no canal #{channel} excederam o limite de menções permitido no período."
      ),
      mentionLimit: 5,
      windowSeconds: 10,
      deleteMessage: true,
      muteDurationSeconds: 600,
      deleteDelaySeconds: 1,
      noticeDeleteDelaySeconds: 5
    },
    autoMod: {
      ...common(
        "<@{user}> sua mensagem contém um termo não permitido neste servidor.",
        "Sua mensagem no canal #{channel} foi removida porque contém um termo não permitido."
      ),
      words: [],
      deleteMessage: true
    },
    antiBot: {
      ...common(
        "Um bot foi identificado e colocado em quarentena preventiva. A autenticação deve ser concluída em até 5 minutos.",
        "Um bot associado à sua conta foi colocado em quarentena no servidor. Consulte a equipe responsável."
      ),
      enabled: false,
      quarantineRoleId: null,
      authTimeoutMs: 5 * 60 * 1000,
      quarantineMs: 7 * 24 * 60 * 60 * 1000,
      authEmbedTitle: "Autenticação obrigatória de bot",
      authEmbedDescription: "Um bot recém-adicionado foi colocado em quarentena preventiva. A autenticação deve ser concluída dentro do prazo informado.",
      authEmbedColor: "#D94A62",
      authEmbedFooter: "Futaba Sakura • Sistema Anti-Bot",
      authSuccessTitle: "Autenticação concluída",
      authSuccessDescription: "A senha foi validada. O bot foi liberado da quarentena.",
      authSuccessColor: "#25C99A",
      authReleasedTitle: "Bot confiável — autenticação dispensada",
      authReleasedDescription: "Este bot foi incluído na whitelist de bots confiáveis. A autenticação do Anti-Bot foi dispensada.",
      authReleasedColor: "#79D68C",
      authExpiredTitle: "Prazo de autenticação expirado",
      authExpiredDescription: "A autenticação não foi concluída. O bot foi banido do servidor.",
      authExpiredColor: "#D94A62",
      authExpiredFailureDescription: "A autenticação não foi concluída. A tentativa de banimento falhou; a equipe foi notificada.",
      passwordSuccessMessage: "Autenticação concluída. O bot foi liberado da quarentena.",
      passwordIncorrectMessage: "Senha incorreta. A autenticação não foi concluída.",
      passwordExpiredMessage: "O prazo de autenticação expirou. O procedimento de segurança foi encerrado.",
      passwordUnavailableMessage: "O prazo de autenticação expirou ou este bot não está em processo de autenticação.",
      passwordNotConfiguredMessage: "A senha do Anti-Bot ainda não foi configurada pela administração.",
      passwordBotMissingMessage: "O bot não está mais no servidor. O registro de autenticação foi encerrado.",
      password: { salt: null, hash: null },
      pending: {},
      blockedBotIds: [],
      trustedBotIds: []
    },
    antiRaid: {
      ...common(
        "A proteção Anti-Raid foi ativada após um padrão incomum de entradas. A equipe está verificando o incidente.",
        "A proteção do servidor foi temporariamente reforçada após uma sequência incomum de entradas."
      ),
      joinLimit: 8,
      windowSeconds: 15,
      lockdownMinutes: 10,
      verificationLevelBeforeLockdown: null,
      lockdownUntil: null
    },
    antiNuke: {
      ...common(
        "A proteção Anti-Nuke identificou uma sequência de alterações administrativas de alto risco. A equipe foi notificada.",
        "Uma sequência de ações administrativas suspeitas foi identificada no servidor. A equipe responsável foi notificada."
      ),
      actionLimit: 3,
      windowSeconds: 12,
      autoBanAdmin: true,
      monitoredAuditActions: [
        "ChannelDelete", "RoleDelete", "ChannelOverwriteDelete", "ChannelOverwriteUpdate",
        "RoleUpdate", "WebhookDelete", "GuildUpdate", "MemberBanAdd"
      ]
    },
    antiLink: {
      ...common(
        "<@{user}> o link enviado não é permitido neste servidor.",
        "O link enviado por você no canal #{channel} não é permitido neste servidor."
      ),
      blacklist: [],
      whitelist: [
        "tenor.com", "media.tenor.com", "c.tenor.com",
        "giphy.com", "media.giphy.com", "i.giphy.com", "giphyusercontent.com", "gph.is"
      ],
      gifExtensions: [".gif", ".gifv"],
      gifWhitelistEnabled: true,
      authorizedRoleIds: [],
      deleteMessage: true
    }
  };
}
