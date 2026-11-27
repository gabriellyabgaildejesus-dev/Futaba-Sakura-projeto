import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { MODULES } from "./defaults.js";
import { getGuildConfig, saveGuildConfig } from "./store.js";
import { canManageFutaba, safeHttpsUrl } from "./security-utils.js";
import { passwordIsConfigured } from "./password.js";
import { handleFutabaSecurityButton, handleFutabaSecurityModal, releaseTrustedBotFromQuarantine } from "./security.js";
import { addAutoModTerms, parseAutoModTerms, removeAutoModTerms } from "./automod-terms.js";

const MODULE_KEYS = Object.keys(MODULES);
const WATCH_CHANNEL_MODULES = new Set(["antiSpam", "antiFlood", "mentionSpam", "autoMod", "antiLink"]);
const LIST_MODULES = new Set(["autoMod", "antiLink", "antiBot"]);
const PAGE_LABELS = {
  overview: "Visão geral",
  channels: "Canais",
  detection: "Detecção e limites",
  punishments: "Punições e exclusão",
  messages: "Mensagens e banner",
  roles: "Cargos e permissões",
  lists: "Palavras e links",
  advanced: "Regras avançadas"
};

export const commandData = new SlashCommandBuilder()
  .setName("futaba")
  .setDescription("Central de controle da Futaba Sakura")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub
    .setName("painel")
    .setDescription("Abre o painel completo de configuração da Futaba Sakura"));

function truncate(value, max = 1000) {
  const text = String(value ?? "—");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function humanList(ids, prefix = "#") {
  return ids?.length ? ids.map(id => `${prefix}${id}`).join(", ") : "Não configurado";
}

function pageOptions(key) {
  const pages = ["overview", "channels", "detection", ...( ["antiSpam", "antiFlood", "mentionSpam"].includes(key) ? ["punishments"] : []), "messages", "roles"];
  if (LIST_MODULES.has(key)) pages.push("lists");
  if (key === "antiNuke") pages.push("advanced");
  return [
    { label: "Painel principal", value: "home", description: "Voltar à seleção de módulos" },
    ...pages.map(value => ({ label: PAGE_LABELS[value], value }))
  ];
}

function pageMenu(key, currentPage) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`futaba:page:${key}`)
      .setPlaceholder(`Seção: ${PAGE_LABELS[currentPage] || "Visão geral"}`)
      .addOptions(pageOptions(key).map(option => ({
        ...option,
        default: option.value === currentPage
      })))
  );
}

function moduleStatus(config, key) {
  const data = config[key];
  const monitored = WATCH_CHANNEL_MODULES.has(key)
    ? `\nCanais monitorados: ${data.watchChannelIds?.length || 0}`
    : "\nMonitoramento: eventos do servidor";
  return `**${MODULES[key]}** · ${data.enabled ? "🟢 Ativo" : "⚪ Desativado"}${monitored}`;
}

export function buildDashboard(guild) {
  const config = getGuildConfig(guild.id);
  const iconURL = guild.client.user?.displayAvatarURL?.();
  const embed = new EmbedBuilder()
    .setColor(0x35D6A4)
    .setTitle("FUTABA SAKURA // CENTRAL DE SEGURANÇA")
    .setDescription([
      "**SECURITY OS • Painel administrativo**",
      "Selecione um módulo para abrir suas configurações. Todas as alterações são salvas no servidor.",
      "",
      ...MODULE_KEYS.map(key => moduleStatus(config, key))
    ].join("\n"))
    .addFields(
      {
        name: "Autenticação Anti-Bot",
        value: passwordIsConfigured(config.antiBot) ? "Senha configurada" : "Senha ainda não configurada",
        inline: true
      },
      {
        name: "Anti-Link",
        value: `Whitelist: ${config.antiLink.whitelist.length} · Blacklist: ${config.antiLink.blacklist.length}`,
        inline: true
      }
    )
    .setFooter({ text: "Futaba Sakura • Security & Moderation" })
    .setTimestamp();
  if (iconURL) embed.setAuthor({ name: "Futaba Sakura • Security OS", iconURL });

  const moduleMenu = new StringSelectMenuBuilder()
    .setCustomId("futaba:module-select")
    .setPlaceholder("Escolha um módulo para configurar")
    .addOptions(MODULE_KEYS.map(key => ({ label: MODULES[key], value: key })));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(moduleMenu)]
  };
}

function channelSummary(data, key) {
  const lines = [];
  if (WATCH_CHANNEL_MODULES.has(key)) {
    lines.push(`**Monitorados:** ${data.watchChannelIds?.length ? data.watchChannelIds.map(id => `<#${id}>`).join(", ") : "Nenhum — mensagens não serão avaliadas"}`);
  } else {
    lines.push("**Monitoramento:** eventos do servidor; não depende de canal de mensagens.");
  }
  lines.push(`**Avisos públicos:** ${data.publicChannelId ? `<#${data.publicChannelId}>` : "Canal de origem / fallback"}`);
  lines.push(`**Logs:** ${data.logChannelId ? `<#${data.logChannelId}>` : "Não configurado"}`);
  lines.push(`**Alertas da equipe:** ${data.staffChannelId ? `<#${data.staffChannelId}>` : "Não configurado"}`);
  return lines.join("\n");
}

function moduleDescription(key, config, page) {
  const data = config[key];
  if (page === "overview") {
    const details = [
      `**Estado:** ${data.enabled ? "🟢 Ativo" : "⚪ Desativado"}`,
      channelSummary(data, key),
      `**Cargos de alerta:** ${data.staffRoleIds?.length ? data.staffRoleIds.map(id => `<@&${id}>`).join(", ") : "Nenhum"}`
    ];
    if (key === "antiBot") {
      details.push(`**Senha:** ${passwordIsConfigured(data) ? "Configurada" : "Não configurada"}`);
      details.push(`**Cargo de quarentena:** ${data.quarantineRoleId ? `<@&${data.quarantineRoleId}>` : "Não configurado"}`);
    }
    if (key === "antiLink") {
      details.push(`**Links:** ${data.whitelist.length} confiáveis · ${data.blacklist.length} proibidos · GIFs ${data.gifWhitelistEnabled ? "permitidos" : "sem exceção automática"}`);
    }
    if (key === "antiBot") details.push(`**Bots confiáveis:** ${(data.trustedBotIds || []).length} na whitelist (ignorados pelo Anti-Bot)`);
    if (key === "autoMod") details.push(`**Termos proibidos:** ${data.words.length}`);
    return details.join("\n\n");
  }
  if (page === "channels") return channelSummary(data, key);
  if (page === "detection") return detectionSummary(key, data);
  if (page === "punishments" && ["antiSpam", "antiFlood", "mentionSpam"].includes(key)) {
    return [
      `**Mute automático:** ${data.muteDurationSeconds ?? 600} segundo(s)${data.muteDurationSeconds === 0 ? " (desativado)" : ""}`,
      `**Excluir mensagens do período:** ${data.deleteMessage === false || data.deleteTriggerMessage === false ? "Desativado" : "Ativado"}`,
      `**Atraso para excluir mensagens do membro:** ${data.deleteDelaySeconds ?? 0} segundo(s)`,
      `**Atraso para excluir o aviso público:** ${data.noticeDeleteDelaySeconds ?? 0} segundo(s)${(data.noticeDeleteDelaySeconds ?? 0) === 0 ? " (aviso permanece no canal)" : ""}`,
      data.deleteDelaySeconds > 0
        ? `Após o atraso, a Futaba busca e apaga todas as mensagens do membro na janela de ${key === "antiSpam" ? data.repeatWindowSeconds : (data.windowSeconds || 10)} segundo(s) que terminou na mensagem detectada.`
        : "Com atraso 0, as mensagens são mantidas; configure um valor maior que 0 para agendar a limpeza.",
      "O timeout depende de Moderar membros. A limpeza também exige Gerenciar mensagens e Ler histórico de mensagens."
    ].join("\n");
  }
  if (page === "lists" && key === "antiBot") return [
    `**Bots confiáveis:** ${(data.trustedBotIds || []).length}`,
    `**IDs cadastrados:** ${(data.trustedBotIds || []).join(", ") || "Nenhum"}`,
    "Bots cadastrados aqui não entram em quarentena, não precisam autenticar e não recebem punições do Anti-Bot. Os demais módulos de segurança continuam funcionando normalmente."
  ].join("\n");
  if (page === "messages") return [
    `**Mensagem pública:** ${truncate(data.publicMessage, 350)}`,
    `**Mensagem privada (DM):** ${truncate(data.dmMessage, 350)}`,
    `**Banner:** ${data.bannerUrl || "Não configurado"}`,
    "",
    "Placeholders disponíveis: `{user}`, `{channel}`, `{type}`, `{action}`, `{content}`."
  ].join("\n");
  if (page === "roles") {
    return [
      `**Cargos mencionados nos alertas:** ${data.staffRoleIds?.length ? data.staffRoleIds.map(id => `<@&${id}>`).join(", ") : "Nenhum"}`,
      key === "antiLink" ? `**Cargos autorizados a enviar links não listados:** ${data.authorizedRoleIds?.length ? data.authorizedRoleIds.map(id => `<@&${id}>`).join(", ") : "Nenhum"}` : "",
      key === "antiBot" ? `**Cargo de quarentena:** ${data.quarantineRoleId ? `<@&${data.quarantineRoleId}>` : "Não configurado"}` : "",
      "A blacklist do Anti-Link continua prevalecendo sobre cargos autorizados."
    ].filter(Boolean).join("\n\n");
  }
  if (page === "lists" && key === "autoMod") {
    return `**Termos configurados (${data.words.length}):**\n${truncate(data.words.join(", ") || "Nenhum termo cadastrado", 900)}`;
  }
  if (page === "lists" && key === "antiLink") {
    return [
      `**Whitelist (${data.whitelist.length}):** ${truncate(data.whitelist.join(", ") || "Vazia", 300)}`,
      `**Blacklist (${data.blacklist.length}):** ${truncate(data.blacklist.join(", ") || "Vazia", 300)}`,
      `**Extensões GIF:** ${(data.gifExtensions || []).join(", ") || "Nenhuma"}`,
      `**Whitelist automática de GIFs:** ${data.gifWhitelistEnabled ? "Ativada" : "Desativada"}`,
      "A blacklist tem prioridade sobre whitelist e cargos autorizados. Links suspeitos continuam sujeitos à análise de risco."
    ].join("\n\n");
  }
  if (page === "advanced" && key === "antiNuke") {
    return `**Ações de auditoria monitoradas (${data.monitoredAuditActions?.length || 0}):**\n${truncate((data.monitoredAuditActions || []).join(", "), 900)}\n\nA alteração da lista muda quais eventos o módulo considera na análise.`;
  }
  return "Esta seção não possui campos adicionais para este módulo.";
}

function detectionSummary(key, data) {
  const fields = {
    antiSpam: [["Repetições", data.repeats], ["Janela (segundos)", data.repeatWindowSeconds], ["Limite de emojis", data.emojiLimit], ["Excluir mensagem", data.deleteMessage]],
    antiFlood: [["Mensagens", data.messageLimit], ["Janela (segundos)", data.windowSeconds], ["Excluir mensagem que disparou", data.deleteTriggerMessage]],
    mentionSpam: [["Limite de menções no período", data.mentionLimit], ["Janela (segundos)", data.windowSeconds], ["Excluir mensagens do período", data.deleteMessage]],
    autoMod: [["Excluir mensagem", data.deleteMessage]],
    antiBot: [["Prazo de autenticação (segundos)", Math.round(data.authTimeoutMs / 1000)], ["Quarentena (dias)", Math.round(data.quarantineMs / 86400000)]],
    antiRaid: [["Entradas para disparo", data.joinLimit], ["Janela (segundos)", data.windowSeconds], ["Bloqueio (minutos)", data.lockdownMinutes]],
    antiNuke: [["Ações para disparo", data.actionLimit], ["Janela (segundos)", data.windowSeconds], ["Banir administrador confirmado", data.autoBanAdmin]],
    antiLink: [["Excluir link bloqueado", data.deleteMessage], ["Whitelist automática de GIFs", data.gifWhitelistEnabled]]
  };
  return (fields[key] || []).map(([label, value]) => `**${label}:** ${typeof value === "boolean" ? (value ? "Sim" : "Não") : value}`).join("\n") || "Sem parâmetros de detecção.";
}

function buildModuleView(guild, key, page = "overview") {
  const config = getGuildConfig(guild.id);
  const data = config[key];
  const iconURL = guild.client.user?.displayAvatarURL?.();
  const embed = new EmbedBuilder()
    .setColor(data.enabled ? 0x35D6A4 : 0x626A73)
    .setTitle(`FUTABA SAKURA // ${MODULES[key]}`)
    .setDescription(moduleDescription(key, config, page))
    .setFooter({ text: `Configuração administrativa • ${PAGE_LABELS[page] || "Módulo"}` })
    .setTimestamp();
  if (iconURL) embed.setAuthor({ name: "Futaba Sakura • Security OS", iconURL });

  const components = [pageMenu(key, page)];
  if (page === "overview") {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`futaba:toggle:${key}:overview`)
        .setLabel(data.enabled ? "Desativar módulo" : "Ativar módulo")
        .setEmoji(data.enabled ? "⏸️" : "🟢")
        .setStyle(data.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
    ));
    if (key === "antiBot") {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("futaba:password").setLabel("Configurar / trocar senha").setEmoji("🔐").setStyle(ButtonStyle.Primary)
      ));
    }
  }

  if (page === "channels") {
    if (WATCH_CHANNEL_MODULES.has(key)) {
      components.push(new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`futaba:channel:${key}:watchChannelIds`)
          .setPlaceholder("Canais que este módulo deve monitorar")
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setDefaultChannels(...(data.watchChannelIds || []).filter(id => guild.channels.cache.has(id)))
          .setMinValues(0)
          .setMaxValues(25)
      ));
    }
    for (const [field, label] of [["publicChannelId", "Canal de avisos públicos"], ["logChannelId", "Canal exclusivo de logs"], ["staffChannelId", "Canal de alertas à equipe"]]) {
      components.push(new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`futaba:channel:${key}:${field}`)
          .setPlaceholder(label)
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setDefaultChannels(...(data[field] && guild.channels.cache.has(data[field]) ? [data[field]] : []))
          .setMinValues(0)
          .setMaxValues(1)
      ));
    }
  }

  if (page === "punishments" && ["antiSpam", "antiFlood", "mentionSpam"].includes(key)) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`futaba:edit:${key}:punishments`).setLabel("Configurar mute e exclusão").setEmoji("🔇").setStyle(ButtonStyle.Primary)
    ));
  }

  if (page === "detection") {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`futaba:edit:${key}:detection`).setLabel("Editar limites e regras").setEmoji("⚙️").setStyle(ButtonStyle.Primary)
    ));
  }

  if (page === "messages") {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`futaba:edit:${key}:messages`).setLabel("Editar mensagens e banner").setEmoji("✏️").setStyle(ButtonStyle.Primary)
    ));
  }

  if (page === "roles") {
    components.push(new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`futaba:roles:${key}:staffRoleIds`)
        .setPlaceholder("Cargos mencionados nos alertas da equipe")
        .setDefaultRoles(...(data.staffRoleIds || []).filter(id => guild.roles.cache.has(id)))
        .setMinValues(0)
        .setMaxValues(25)
    ));
    if (key === "antiLink") {
      components.push(new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`futaba:roles:${key}:authorizedRoleIds`)
          .setPlaceholder("Cargos autorizados a enviar links")
          .setDefaultRoles(...(data.authorizedRoleIds || []).filter(id => guild.roles.cache.has(id)))
          .setMinValues(0)
          .setMaxValues(25)
      ));
    }
    if (key === "antiBot") {
      components.push(new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`futaba:roles:${key}:quarantineRoleId`)
          .setPlaceholder("Cargo de quarentena do Anti-Bot")
          .setDefaultRoles(...(data.quarantineRoleId && guild.roles.cache.has(data.quarantineRoleId) ? [data.quarantineRoleId] : []))
          .setMinValues(0)
          .setMaxValues(1)
      ));
    }
  }

  if (page === "lists") {
    if (key === "autoMod") {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("futaba:words-add").setLabel("Adicionar palavras").setEmoji("➕").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("futaba:words-remove").setLabel("Remover palavras").setEmoji("➖").setStyle(ButtonStyle.Danger)
      ));
    } else {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`futaba:edit:${key}:lists`).setLabel(key === "antiBot" ? "Gerenciar whitelist de bots" : "Editar whitelist / blacklist").setEmoji("📝").setStyle(ButtonStyle.Primary)
      ));
    }
    if (key === "antiLink") {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("futaba:toggle-gif-whitelist")
          .setLabel(data.gifWhitelistEnabled ? "Desativar whitelist automática de GIFs" : "Ativar whitelist automática de GIFs")
          .setStyle(data.gifWhitelistEnabled ? ButtonStyle.Secondary : ButtonStyle.Success)
      ));
    }
  }

  if (page === "advanced" && key === "antiNuke") {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`futaba:edit:${key}:advanced`).setLabel("Editar eventos de auditoria").setEmoji("🛡️").setStyle(ButtonStyle.Primary)
    ));
  }
  return { embeds: [embed], components };
}

function makeInput(id, label, value, { paragraph = false, required = false, max = 1000, placeholder = "" } = {}) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label.slice(0, 45))
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(required)
    .setMaxLength(max);
  if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
  const normalized = String(value ?? "");
  if (normalized) input.setValue(normalized.slice(0, max));
  return new ActionRowBuilder().addComponents(input);
}

function createAutoModTermsModal(operation) {
  const adding = operation === "add";
  const modal = new ModalBuilder()
    .setCustomId(`futaba:words-${operation}`)
    .setTitle(adding ? "AutoMod • Adicionar palavras" : "AutoMod • Remover palavras");
  const input = new TextInputBuilder()
    .setCustomId("terms")
    .setLabel(adding ? "Novos termos (um por linha)" : "Termos para remover (um por linha)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder(adding ? "termo 1\ntermo 2\ntermo 3" : "termo a remover\noutro termo");
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function createSettingsModal(key, type, config) {
  const data = config[key];
  const modal = new ModalBuilder()
    .setCustomId(`futaba:modal-save:${key}:${type}`)
    .setTitle(`${MODULES[key]} • ${type === "detection" ? "Detecção" : type === "messages" ? "Mensagens" : type === "lists" ? "Listas" : "Regras avançadas"}`.slice(0, 45));
  const rows = [];

  if (type === "detection") {
    const definitions = {
      antiSpam: [
        ["repeats", "Número de repetições", data.repeats, false],
        ["repeatWindowSeconds", "Janela de repetição (s)", data.repeatWindowSeconds, false],
        ["emojiLimit", "Limite de emojis", data.emojiLimit, false],
        ["deleteMessage", "Excluir mensagem? true/false", data.deleteMessage, false]
      ],
      antiFlood: [
        ["messageLimit", "Mensagens para disparar", data.messageLimit, false],
        ["windowSeconds", "Janela de tempo (s)", data.windowSeconds, false],
        ["deleteTriggerMessage", "Excluir mensagem? true/false", data.deleteTriggerMessage, false]
      ],
      mentionSpam: [["mentionLimit", "Limite de menções no período", data.mentionLimit, false], ["windowSeconds", "Janela de menções (s)", data.windowSeconds, false], ["deleteMessage", "Excluir mensagens? true/false", data.deleteMessage, false]],
      autoMod: [["deleteMessage", "Excluir mensagem? true/false", data.deleteMessage, false]],
      antiBot: [["authTimeoutSeconds", "Prazo de autenticação (s)", Math.round(data.authTimeoutMs / 1000), false], ["quarantineDays", "Duração da quarentena (dias)", Math.round(data.quarantineMs / 86400000), false]],
      antiRaid: [["joinLimit", "Entradas para disparar", data.joinLimit, false], ["windowSeconds", "Janela de entradas (s)", data.windowSeconds, false], ["lockdownMinutes", "Duração do bloqueio (min)", data.lockdownMinutes, false]],
      antiNuke: [["actionLimit", "Ações para disparar", data.actionLimit, false], ["windowSeconds", "Janela de ações (s)", data.windowSeconds, false], ["autoBanAdmin", "Banir autor confirmado? true/false", data.autoBanAdmin, false]],
      antiLink: [["deleteMessage", "Excluir link bloqueado? true/false", data.deleteMessage, false], ["gifWhitelistEnabled", "Whitelist automática de GIFs? true/false", data.gifWhitelistEnabled, false]]
    };
    for (const [id, label, value] of definitions[key] || []) {
      rows.push(makeInput(id, label, typeof value === "boolean" ? String(value) : value, { required: true, max: 20, placeholder: "Use um número ou true/false" }));
    }
  }

  if (type === "punishments" && ["antiSpam", "antiFlood", "mentionSpam"].includes(key)) {
    const deleteEnabled = key === "antiFlood" ? data.deleteTriggerMessage : data.deleteMessage;
    rows.push(makeInput("muteDurationSeconds", "Duração do mute em segundos (0 desativa)", data.muteDurationSeconds ?? 600, { required: true, max: 8, placeholder: "600" }));
    rows.push(makeInput("deleteEnabled", "Excluir mensagem? true/false", deleteEnabled !== false, { required: true, max: 5, placeholder: "true ou false" }));
    rows.push(makeInput("deleteDelaySeconds", "Atraso p/ apagar mensagens (0 mantém)", data.deleteDelaySeconds ?? 0, { required: true, max: 5, placeholder: "1" }));
    rows.push(makeInput("noticeDeleteDelaySeconds", "Atraso p/ apagar aviso (0 mantém)", data.noticeDeleteDelaySeconds ?? 5, { required: true, max: 5, placeholder: "5" }));
  }

  if (type === "messages") {
    rows.push(makeInput("publicMessage", "Mensagem pública", data.publicMessage, { paragraph: true, max: 1800, placeholder: "Texto enviado no canal de avisos" }));
    rows.push(makeInput("dmMessage", "Mensagem privada (DM)", data.dmMessage, { paragraph: true, max: 1800, placeholder: "Texto enviado por mensagem privada" }));
    rows.push(makeInput("bannerUrl", "URL HTTPS do banner (vazio remove)", data.bannerUrl, { max: 500, placeholder: "https://..." }));
  }

  if (type === "lists" && key === "autoMod") {
    throw new Error("Use os botões Adicionar palavras e Remover palavras. A lista é gerenciada em lotes para não truncar termos já salvos.");
  }
  if (type === "lists" && key === "antiBot") {
    rows.push(makeInput("trustedBotIds", "IDs dos bots confiáveis (um por linha)", (data.trustedBotIds || []).join("\n"), { paragraph: true, max: 4000, placeholder: "ID da Loritta\nID de outro bot confiável" }));
  }
  if (type === "lists" && key === "antiLink") {
    rows.push(makeInput("whitelist", "Whitelist — domínios/URLs confiáveis, um por linha", data.whitelist.join("\n"), { paragraph: true, max: 4000, placeholder: "tenor.com\ngiphy.com" }));
    rows.push(makeInput("blacklist", "Blacklist — domínios/URLs bloqueados, um por linha", data.blacklist.join("\n"), { paragraph: true, max: 4000, placeholder: "exemplo-perigoso.com" }));
    rows.push(makeInput("gifExtensions", "Extensões de GIF, separadas por vírgula", (data.gifExtensions || []).join(", "), { max: 250, placeholder: ".gif, .gifv" }));
  }
  if (type === "advanced" && key === "antiNuke") {
    rows.push(makeInput("monitoredAuditActions", "Eventos de auditoria (um nome por linha)", (data.monitoredAuditActions || []).join("\n"), { paragraph: true, max: 4000, placeholder: "ChannelDelete\nRoleDelete\nWebhookDelete" }));
  }

  if (!rows.length) throw new Error("Não há campos de configuração para esta seção.");
  modal.addComponents(...rows);
  return modal;
}

function parseBoolean(value, label) {
  const normalized = String(value).trim().toLowerCase();
  if (["true", "sim", "s", "1"].includes(normalized)) return true;
  if (["false", "não", "nao", "n", "0"].includes(normalized)) return false;
  throw new Error(`${label}: use true ou false.`);
}

function parseInteger(value, label, min, max) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${label}: informe um número inteiro.`);
  const number = Number(text);
  if (number < min || number > max) throw new Error(`${label}: use um valor entre ${min} e ${max}.`);
  return number;
}

function normalizeLinkRule(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Regra de link vazia.");
  if (/^https:\/\//i.test(raw)) {
    const url = new URL(raw);
    return `${url.hostname.toLowerCase()}${url.pathname === "/" ? "" : url.pathname}`;
  }
  const domain = raw.toLowerCase().replace(/^\*\./, "").replace(/^www\./, "");
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/.test(domain)) {
    throw new Error(`Domínio inválido: ${raw}. Use exemplo.com ou uma URL HTTPS.`);
  }
  return domain;
}

function parseLines(value) {
  return [...new Set(String(value || "").split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
}

async function saveModalValues(interaction, key, type) {
  const releaseWhitelistedBotIds = [];
  const config = getGuildConfig(interaction.guildId);
  const data = config[key];

  if (type === "detection") {
    const specs = {
      antiSpam: { repeats: [2, 100], repeatWindowSeconds: [1, 300], emojiLimit: [1, 100], deleteMessage: "bool" },
      antiFlood: { messageLimit: [2, 100], windowSeconds: [1, 300], deleteTriggerMessage: "bool" },
      mentionSpam: { mentionLimit: [2, 100], windowSeconds: [1, 300], deleteMessage: "bool" },
      autoMod: { deleteMessage: "bool" },
      antiBot: { authTimeoutSeconds: [30, 1800], quarantineDays: [1, 28] },
      antiRaid: { joinLimit: [2, 100], windowSeconds: [1, 300], lockdownMinutes: [1, 1440] },
      antiNuke: { actionLimit: [2, 100], windowSeconds: [1, 300], autoBanAdmin: "bool" },
      antiLink: { deleteMessage: "bool", gifWhitelistEnabled: "bool" }
    };
    for (const [field, rule] of Object.entries(specs[key] || {})) {
      const raw = interaction.fields.getTextInputValue(field);
      if (rule === "bool") data[field] = parseBoolean(raw, field);
      else {
        const number = parseInteger(raw, field, rule[0], rule[1]);
        if (key === "antiBot" && field === "authTimeoutSeconds") data.authTimeoutMs = number * 1000;
        else if (key === "antiBot" && field === "quarantineDays") data.quarantineMs = number * 86400000;
        else data[field] = number;
      }
    }
  }

  if (type === "punishments" && ["antiSpam", "antiFlood", "mentionSpam"].includes(key)) {
    const mute = parseInteger(interaction.fields.getTextInputValue("muteDurationSeconds"), "Duração do mute", 0, 2_419_200);
    const delay = parseInteger(interaction.fields.getTextInputValue("deleteDelaySeconds"), "Atraso para excluir mensagens", 0, 3600);
    const noticeDelay = parseInteger(interaction.fields.getTextInputValue("noticeDeleteDelaySeconds"), "Atraso para excluir aviso", 0, 3600);
    const deleteEnabled = parseBoolean(interaction.fields.getTextInputValue("deleteEnabled"), "Excluir mensagem");
    data.muteDurationSeconds = mute;
    data.deleteDelaySeconds = delay;
    data.noticeDeleteDelaySeconds = noticeDelay;
    if (key === "antiFlood") data.deleteTriggerMessage = deleteEnabled;
    else data.deleteMessage = deleteEnabled;
  }

  if (type === "messages") {
    data.publicMessage = interaction.fields.getTextInputValue("publicMessage").trim();
    data.dmMessage = interaction.fields.getTextInputValue("dmMessage").trim();
    const banner = interaction.fields.getTextInputValue("bannerUrl").trim();
    if (!banner) data.bannerUrl = null;
    else {
      const valid = safeHttpsUrl(banner);
      if (!valid) throw new Error("O banner precisa ser uma URL HTTPS válida.");
      data.bannerUrl = valid;
    }
  }

  if (type === "lists" && key === "autoMod") {
    throw new Error("A lista do AutoMod deve ser alterada pelos botões Adicionar palavras ou Remover palavras.");
  }

  if (type === "lists" && key === "antiBot") {
    const trustedBotIds = parseLines(interaction.fields.getTextInputValue("trustedBotIds"));
    if (trustedBotIds.length > 100) throw new Error("A whitelist aceita até 100 bots.");
    if (trustedBotIds.some(id => !/^\d{17,20}$/.test(id))) throw new Error("Há um ID inválido. Use apenas IDs de usuário/bot do Discord.");
    // Novos bots confiáveis são liberados também se já estiverem em quarentena.
    const previous = new Set(data.trustedBotIds || []);
    data.trustedBotIds = [...new Set(trustedBotIds)];
    releaseWhitelistedBotIds.push(...data.trustedBotIds.filter(id => !previous.has(id)));
  }

  if (type === "lists" && key === "antiLink") {
    const whitelist = parseLines(interaction.fields.getTextInputValue("whitelist"));
    const blacklist = parseLines(interaction.fields.getTextInputValue("blacklist"));
    const extensions = interaction.fields.getTextInputValue("gifExtensions").split(/[\s,]+/).map(value => value.trim().toLowerCase()).filter(Boolean);
    if (whitelist.length > 100 || blacklist.length > 100) throw new Error("Cada lista aceita até 100 regras.");
    data.whitelist = [...new Set(whitelist.map(normalizeLinkRule))];
    data.blacklist = [...new Set(blacklist.map(normalizeLinkRule))];
    if (extensions.some(extension => !/^\.[a-z0-9]{2,8}$/.test(extension))) throw new Error("Extensão inválida. Use formatos como .gif ou .gifv.");
    data.gifExtensions = [...new Set(extensions)];
  }

  if (type === "advanced" && key === "antiNuke") {
    const actions = parseLines(interaction.fields.getTextInputValue("monitoredAuditActions"));
    if (actions.length > 40) throw new Error("Configure no máximo 40 eventos de auditoria.");
    if (actions.some(action => !/^[A-Za-z][A-Za-z0-9]{1,63}$/.test(action))) throw new Error("Há um nome de evento inválido. Use nomes como ChannelDelete.");
    data.monitoredAuditActions = actions;
  }

  await saveGuildConfig(interaction.guildId, config);
  for (const botId of releaseWhitelistedBotIds) {
    await releaseTrustedBotFromQuarantine(interaction.client, interaction.guild, botId);
  }
}

function canUsePanel(interaction) {
  return Boolean(interaction.guildId && interaction.guildId === process.env.POOL_PARTY_GUILD_ID && canManageFutaba(interaction.member, interaction.guild?.ownerId));
}

export async function handleFutabaCommand(client, interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "futaba") return false;
  if (!interaction.guild) {
    await interaction.reply({ content: "O painel só pode ser usado dentro de um servidor.", ephemeral: true });
    return true;
  }
  if (interaction.guildId !== process.env.POOL_PARTY_GUILD_ID) {
    await interaction.reply({ content: "A Futaba Sakura está disponível exclusivamente no POOL PARTY.", ephemeral: true });
    return true;
  }
  if (!canUsePanel(interaction)) {
    await interaction.reply({ content: "Acesso restrito à administração do servidor.", ephemeral: true });
    return true;
  }
  return interaction.reply({ ...buildDashboard(interaction.guild), ephemeral: true });
}

export async function handlePanelInteraction(client, interaction) {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith("futaba:bot-auth:")) return handleFutabaSecurityButton(interaction);
    if (!canUsePanel(interaction)) return interaction.reply({ content: "Acesso restrito à administração.", ephemeral: true });

    if (interaction.customId === "futaba:panel-home") return interaction.update(buildDashboard(interaction.guild));

    if (interaction.customId.startsWith("futaba:toggle:")) {
      const [, , key, page = "overview"] = interaction.customId.split(":");
      if (!Object.hasOwn(MODULES, key)) return interaction.reply({ content: "Módulo inválido.", ephemeral: true });
      const config = getGuildConfig(interaction.guildId);
      const nextEnabled = !config[key].enabled;
      if (key === "antiBot" && nextEnabled && !passwordIsConfigured(config.antiBot)) {
        return interaction.reply({ content: "Configure primeiro a senha do Anti-Bot nesta própria tela. O módulo continua desativado.", ephemeral: true });
      }
      config[key].enabled = nextEnabled;
      await saveGuildConfig(interaction.guildId, config);
      return interaction.update(buildModuleView(interaction.guild, key, page));
    }

    if (interaction.customId === "futaba:password") {
      const { showPasswordSetupModal } = await import("./panel.js");
      return showPasswordSetupModal(interaction, getGuildConfig(interaction.guildId));
    }

    if (interaction.customId === "futaba:toggle-gif-whitelist") {
      const config = getGuildConfig(interaction.guildId);
      config.antiLink.gifWhitelistEnabled = !config.antiLink.gifWhitelistEnabled;
      await saveGuildConfig(interaction.guildId, config);
      return interaction.update(buildModuleView(interaction.guild, "antiLink", "lists"));
    }

    if (interaction.customId === "futaba:words-add") return interaction.showModal(createAutoModTermsModal("add"));
    if (interaction.customId === "futaba:words-remove") return interaction.showModal(createAutoModTermsModal("remove"));

    if (interaction.customId.startsWith("futaba:edit:")) {
      const [, , key, type] = interaction.customId.split(":");
      if (!Object.hasOwn(MODULES, key)) return interaction.reply({ content: "Módulo inválido.", ephemeral: true });
      if (key === "autoMod" && type === "lists") {
        return interaction.reply({ content: "Use os botões Adicionar palavras e Remover palavras na seção Listas do AutoMod. Assim, os lotes não substituem nem truncam a lista salva.", ephemeral: true });
      }
      return interaction.showModal(createSettingsModal(key, type, getGuildConfig(interaction.guildId)));
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (!canUsePanel(interaction)) return interaction.reply({ content: "Acesso restrito à administração.", ephemeral: true });
    if (interaction.customId === "futaba:module-select") {
      const key = interaction.values[0];
      if (!Object.hasOwn(MODULES, key)) return interaction.reply({ content: "Módulo inválido.", ephemeral: true });
      return interaction.update(buildModuleView(interaction.guild, key, "overview"));
    }
    if (interaction.customId.startsWith("futaba:page:")) {
      const key = interaction.customId.split(":")[2];
      const page = interaction.values[0];
      if (!Object.hasOwn(MODULES, key)) return interaction.reply({ content: "Módulo inválido.", ephemeral: true });
      if (page === "home") return interaction.update(buildDashboard(interaction.guild));
      if (!pageOptions(key).some(option => option.value === page)) return interaction.reply({ content: "Seção inválida.", ephemeral: true });
      return interaction.update(buildModuleView(interaction.guild, key, page));
    }
  }

  if (interaction.isChannelSelectMenu() && interaction.customId.startsWith("futaba:channel:")) {
    if (!canUsePanel(interaction)) return interaction.reply({ content: "Acesso restrito à administração.", ephemeral: true });
    const [, , key, field] = interaction.customId.split(":");
    if (!Object.hasOwn(MODULES, key)) return interaction.reply({ content: "Módulo inválido.", ephemeral: true });
    const config = getGuildConfig(interaction.guildId);
    if (field === "watchChannelIds") {
      if (!WATCH_CHANNEL_MODULES.has(key)) return interaction.reply({ content: "Este módulo usa eventos do servidor e não possui canais de monitoramento de mensagens.", ephemeral: true });
      config[key].watchChannelIds = [...interaction.values];
    } else if (["publicChannelId", "logChannelId", "staffChannelId"].includes(field)) {
      config[key][field] = interaction.values[0] || null;
    } else {
      return interaction.reply({ content: "Campo de canal inválido.", ephemeral: true });
    }
    await saveGuildConfig(interaction.guildId, config);
    return interaction.update(buildModuleView(interaction.guild, key, "channels"));
  }

  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith("futaba:roles:")) {
    if (!canUsePanel(interaction)) return interaction.reply({ content: "Acesso restrito à administração.", ephemeral: true });
    const [, , key, field] = interaction.customId.split(":");
    if (!Object.hasOwn(MODULES, key)) return interaction.reply({ content: "Módulo inválido.", ephemeral: true });
    const config = getGuildConfig(interaction.guildId);
    // Impede @everyone em listas de cargos para evitar autorizações/menções globais acidentais.
    const selectedRoleIds = interaction.values.filter(id => id !== interaction.guildId && interaction.guild.roles.cache.has(id));
    if (field === "quarantineRoleId" && key === "antiBot") config.antiBot.quarantineRoleId = selectedRoleIds[0] || null;
    else if (field === "staffRoleIds") config[key].staffRoleIds = selectedRoleIds;
    else if (field === "authorizedRoleIds" && key === "antiLink") config.antiLink.authorizedRoleIds = selectedRoleIds;
    else return interaction.reply({ content: "Campo de cargo inválido.", ephemeral: true });
    await saveGuildConfig(interaction.guildId, config);
    return interaction.update(buildModuleView(interaction.guild, key, "roles"));
  }

  if (interaction.isModalSubmit() && ["futaba:words-add", "futaba:words-remove"].includes(interaction.customId)) {
    if (!canUsePanel(interaction)) return interaction.reply({ content: "Acesso restrito à administração.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      const operation = interaction.customId === "futaba:words-add" ? "add" : "remove";
      const submitted = parseAutoModTerms(interaction.fields.getTextInputValue("terms"));
      if (!submitted.length) throw new Error("Informe pelo menos um termo, com um por linha.");
      const config = getGuildConfig(interaction.guildId);
      const current = Array.isArray(config.autoMod.words) ? config.autoMod.words : [];
      if (operation === "add") {
        const result = addAutoModTerms(current, submitted);
        config.autoMod.words = result.terms;
        await saveGuildConfig(interaction.guildId, config);
        await interaction.editReply({
          content: `${result.added} termo(s) adicionado(s); ${result.duplicates} já existia(m). Total salvo: ${result.terms.length}. Você pode enviar outros lotes sem limite total de 100 termos.`
        });
      } else {
        const result = removeAutoModTerms(current, submitted);
        config.autoMod.words = result.terms;
        await saveGuildConfig(interaction.guildId, config);
        await interaction.editReply({
          content: `${result.removed} termo(s) removido(s). ${result.notFound} não foi(ram) encontrado(s). Total restante: ${result.terms.length}.`
        });
      }
    } catch (error) {
      await interaction.editReply({ content: `Não foi possível atualizar as palavras do AutoMod: ${error.message}` });
    }
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("futaba:modal-save:")) {
    if (!canUsePanel(interaction)) return interaction.reply({ content: "Acesso restrito à administração.", ephemeral: true });
    const [, , key, type] = interaction.customId.split(":");
    if (!Object.hasOwn(MODULES, key)) return interaction.reply({ content: "Módulo inválido.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      await saveModalValues(interaction, key, type);
      await interaction.editReply({ content: `Configurações de **${MODULES[key]}** salvas com sucesso. Volte ao painel da Futaba para conferir os valores atualizados.` });
    } catch (error) {
      await interaction.editReply({ content: `Não foi possível salvar as alterações: ${error.message}` });
    }
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("futaba:bot-auth-submit:")) {
    return handleFutabaSecurityModal(client, interaction);
  }
  if (interaction.isModalSubmit() && interaction.customId === "futaba:password-save") {
    const { handlePasswordSubmit } = await import("./panel.js");
    return handlePasswordSubmit(interaction);
  }
  return false;
}

export async function registerCommands(client) {
  const { REST, Routes } = await import("discord.js");
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const applicationId = process.env.CLIENT_ID;
  const allowedGuildId = process.env.POOL_PARTY_GUILD_ID;
  if (!/^\d{17,20}$/.test(allowedGuildId || "")) throw new Error("POOL_PARTY_GUILD_ID precisa ser o ID real do POOL PARTY.");
  const body = [commandData.toJSON()];
  const guildIds = [...client.guilds.cache.keys()];

  // O comando fica registrado apenas no servidor oficial.
  await rest.put(Routes.applicationCommands(applicationId), { body: [] });
  for (const guildId of guildIds) {
    if (guildId !== allowedGuildId) await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] });
  }
  await rest.put(Routes.applicationGuildCommands(applicationId, allowedGuildId), { body });
  console.log("[Futaba] Somente /futaba painel foi registrado no POOL PARTY.");
}
