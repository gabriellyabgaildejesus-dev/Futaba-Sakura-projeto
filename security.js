import {
  ActionRowBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildVerificationLevel,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import { getGuildConfig, saveGuildConfig } from "./store.js";
import { safeHttpsUrl } from "./security-utils.js";
import { passwordIsConfigured, verifyPassword } from "./password.js";
import { sendMemberDM, sendModuleLog, sendPublicNotice, sendStaffAlert } from "./notifications.js";
import { detectProtectedBotIntervention, isTrustedAntiBot } from "./anti-bot-interventions.js";

const raidJoins = new Map();
const nukeActions = new Map();
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 28 * DAY_MS;

async function fetchTextChannel(client, id) {
  if (!id) return null;
  const channel = await client.channels.fetch(id).catch(() => null);
  return channel?.isTextBased?.() && channel.messages ? channel : null;
}

async function ensureQuarantineRole(guild, config) {
  let role = config.antiBot.quarantineRoleId
    ? await guild.roles.fetch(config.antiBot.quarantineRoleId).catch(() => null)
    : null;
  if (!role) {
    role = await guild.roles.create({
      name: "Futaba | Quarentena",
      color: 0xD94A62,
      permissions: [],
      hoist: false,
      mentionable: false,
      reason: "Cargo de isolamento do Anti-Bot da Futaba Sakura"
    });
    config.antiBot.quarantineRoleId = role.id;
    await saveGuildConfig(guild.id, config);
  }
  const deny = {
    ViewChannel: false,
    SendMessages: false,
    AddReactions: false,
    Connect: false,
    Speak: false,
    SendMessagesInThreads: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false
  };
  for (const channel of guild.channels.cache.values()) {
    try {
      await channel.permissionOverwrites.edit(role, deny, {
        reason: "Restringir acesso de bots em quarentena"
      });
    } catch {
      // Canais fora do alcance da Futaba ficam registrados como limitação de permissão.
    }
  }
  return role;
}

async function findBotInviter(guild, botId) {
  try {
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 10 });
    const entry = logs.entries.find(item =>
      item.targetId === botId && Date.now() - item.createdTimestamp < 60_000
    );
    if (!entry?.executorId) return null;
    return await guild.members.fetch(entry.executorId).catch(() => null);
  } catch (error) {
    console.warn(`[Futaba] Não foi possível identificar quem adicionou o bot ${botId}: ${error.message}`);
    return null;
  }
}

async function notifySecurity(client, guild, moduleKey, moduleConfig, title, description, details = {}) {
  const alertDetails = { infraction: title, action: description, ...details };
  await sendStaffAlert(client, guild, moduleKey, title, alertDetails, moduleConfig);
  await sendModuleLog(client, guild, moduleKey, title, alertDetails, moduleConfig);
}

function configuredSecurityColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? Number.parseInt(value.slice(1), 16) : fallback;
}

async function publishBotAuth(client, guild, botUser, moduleConfig, deadline) {
  const configuredChannels = [moduleConfig.publicChannelId, moduleConfig.staffChannelId];
  const fallbackChannels = [guild.systemChannelId, ...guild.channels.cache
    .filter(item => item.isTextBased?.() && item.messages)
    .map(item => item.id)];
  let channel = null;
  for (const channelId of [...configuredChannels, ...fallbackChannels].filter(Boolean)) {
    channel = await fetchTextChannel(client, channelId);
    if (!channel) continue;
    const botMember = guild.members.me;
    const permissions = botMember ? channel.permissionsFor(botMember) : null;
    if (!permissions || (permissions.has(PermissionFlagsBits.ViewChannel) && permissions.has(PermissionFlagsBits.SendMessages) && permissions.has(PermissionFlagsBits.EmbedLinks))) break;
    channel = null;
  }
  if (!channel) return null;
  const embed = new EmbedBuilder()
    .setColor(configuredSecurityColor(moduleConfig.authEmbedColor, 0xD94A62))
    .setTitle(moduleConfig.authEmbedTitle || "Autenticação obrigatória de bot")
    .setDescription(moduleConfig.authEmbedDescription || "Um bot recém-adicionado foi colocado em quarentena preventiva. A autenticação deve ser concluída dentro do prazo informado.")
    .addFields(
      { name: "Bot detectado", value: `${botUser.tag}\n\`${botUser.id}\``, inline: true },
      { name: "Prazo", value: `${Math.max(1, Math.ceil((moduleConfig.authTimeoutMs || 300000) / 60000))} minuto(s)`, inline: true },
      { name: "Estado", value: "Quarentena ativa", inline: true }
    )
    .setFooter({ text: moduleConfig.authEmbedFooter || "Futaba Sakura • Sistema Anti-Bot" })
    .setTimestamp(new Date(deadline - moduleConfig.authTimeoutMs));
  const banner = safeHttpsUrl(moduleConfig.bannerUrl);
  if (banner) embed.setImage(banner);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`futaba:bot-auth:${botUser.id}`)
      .setLabel("Inserir senha de autenticação")
      .setStyle(ButtonStyle.Danger)
  );
  try {
    const sent = await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    return { channelId: channel.id, messageId: sent.id };
  } catch (error) {
    console.error(`[Futaba] Não foi possível publicar autenticação: ${error.message}`);
    return null;
  }
}

export async function releaseTrustedBotFromQuarantine(client, guild, botId) {
  const config = getGuildConfig(guild.id);
  const mod = config.antiBot;
  mod.pending ||= {};
  const pending = mod.pending[botId];
  if (!pending) return { released: false, issues: [] };

  const issues = [];
  const member = await guild.members.fetch(botId).catch(() => null);
  if (member) {
    try {
      await member.timeout(null, "Bot adicionado à whitelist confiável do Anti-Bot");
    } catch (error) {
      issues.push(`Não foi possível remover o timeout: ${error.message}`);
    }
    if (pending.quarantineRoleId) {
      const quarantineRole = await guild.roles.fetch(pending.quarantineRoleId).catch(() => null);
      if (quarantineRole && member.roles.cache.has(quarantineRole.id)) {
        try { await member.roles.remove(quarantineRole, "Bot adicionado à whitelist confiável"); }
        catch (error) { issues.push(`Não foi possível remover o cargo de quarentena: ${error.message}`); }
      }
    }
    for (const roleId of pending.originalRoleIds || []) {
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role || !role.editable || member.roles.cache.has(roleId)) continue;
      try { await member.roles.add(role, "Restaurar cargo original após inclusão na whitelist confiável"); }
      catch (error) { issues.push(`Não foi possível restaurar o cargo ${roleId}: ${error.message}`); }
    }
  }

  delete mod.pending[botId];
  await saveGuildConfig(guild.id, config);

  const channel = await fetchTextChannel(client, pending.authChannelId);
  if (channel && pending.authMessageId) {
    const message = await channel.messages.fetch(pending.authMessageId).catch(() => null);
    if (message) {
      const embed = EmbedBuilder.from(message.embeds[0] || new EmbedBuilder())
        .setColor(configuredSecurityColor(mod.authReleasedColor, 0x79D68C))
        .setTitle(mod.authReleasedTitle || "Bot confiável — autenticação dispensada")
        .setDescription(mod.authReleasedDescription || "Este bot foi incluído na whitelist de bots confiáveis. A autenticação do Anti-Bot foi dispensada.")
        .setTimestamp();
      await message.edit({ embeds: [embed], components: [], allowedMentions: { parse: [] } }).catch(() => null);
    }
  }

  await notifySecurity(
    client, guild, "Anti-Bot", mod,
    "Bot liberado após inclusão na whitelist",
    "Um bot em quarentena foi incluído na whitelist confiável. A Futaba tentou remover as restrições e restaurar os cargos anteriores.",
    { Bot: botId, Resultado: issues.length ? issues.join("\n") : (member ? "Restrições removidas e cargos restaurados" : "Bot não está mais no servidor; autenticação pendente encerrada") }
  );
  return { released: true, issues };
}

export async function quarantineBot(client, member) {
  const guild = member.guild;
  const config = getGuildConfig(guild.id);
  const mod = config.antiBot;
  // Bots confiáveis são excluídos exclusivamente do Anti-Bot, antes de qualquer alerta ou punição.
  if (isTrustedAntiBot(mod, member.id)) return;
  if (!mod.enabled) return;
  if (mod.pending[member.id]) return;
  if ((mod.blockedBotIds || []).includes(member.id)) {
    await guild.members.ban(member.id, { reason: "Bot anteriormente bloqueado pelo Anti-Bot da Futaba Sakura." }).catch(() => null);
    await notifySecurity(client, guild, "Anti-Bot", mod, "Bot anteriormente bloqueado tentou retornar", "Um bot com registro de bloqueio voltou a entrar no servidor. Foi realizada uma nova tentativa de banimento.", { Bot: `${member.user.tag} (${member.id})` });
    return;
  }

  const now = Date.now();
  const deadline = now + Number(mod.authTimeoutMs || 300000);
  const role = await ensureQuarantineRole(guild, config);
  const originalRoleIds = member.roles.cache
    .filter(item => item.id !== guild.id && item.id !== role.id && item.editable)
    .map(item => item.id);
  let timeoutApplied = false;
  const problems = [];

  try {
    if (originalRoleIds.length) await member.roles.remove(originalRoleIds, "Quarentena preventiva do Anti-Bot");
  } catch (error) {
    problems.push(`Não foi possível remover todos os cargos: ${error.message}`);
  }
  try {
    await member.roles.add(role, "Quarentena preventiva do Anti-Bot");
  } catch (error) {
    problems.push(`Não foi possível atribuir o cargo de quarentena: ${error.message}`);
  }
  try {
    const duration = Math.min(Number(mod.quarantineMs || 7 * DAY_MS), MAX_TIMEOUT_MS);
    await member.timeout(duration, "Quarentena de segurança para autenticação de bot");
    timeoutApplied = true;
  } catch (error) {
    problems.push(`O Discord recusou o castigo de sete dias; quarentena por permissões será usada: ${error.message}`);
  }

  const authMessage = await publishBotAuth(client, guild, member.user, mod, deadline);
  const inviter = await findBotInviter(guild, member.id);
  if (inviter) {
    await sendMemberDM(inviter, mod.dmMessage, {
      user: member.id,
      channel: "servidor",
      type: "novo bot em quarentena",
      action: "autenticação obrigatória em cinco minutos",
      content: member.user.tag
    });
  }
  await sendPublicNotice(client, null, mod,
    mod.publicMessage || "Um bot foi detectado e colocado em quarentena preventiva. O procedimento de autenticação tem prazo de cinco minutos.",
    { user: member.id, type: "bot recém-detectado", action: "quarentena e autenticação", content: member.user.tag }, "danger");
  mod.pending[member.id] = {
    botId: member.id,
    deadline,
    originalRoleIds,
    quarantineRoleId: role.id,
    authChannelId: authMessage?.channelId || null,
    authMessageId: authMessage?.messageId || null,
    timeoutApplied,
    failedAttempts: 0,
    detectedAt: now
  };
  await saveGuildConfig(guild.id, config);

  await notifySecurity(
    client, guild, "Anti-Bot", mod, "Novo bot colocado em quarentena",
    "Um bot foi detectado e isolado preventivamente. O prazo de autenticação de cinco minutos foi iniciado.",
    { Bot: `${member.user.tag} (${member.id})`, "Adicionado por": inviter ? `${inviter.user.tag} (${inviter.id})` : "Não identificado no audit log", Prazo: new Date(deadline).toISOString(), "Restrições aplicadas": problems.length ? problems.join("\n") : "Cargos removidos, quarentena aplicada e castigo solicitado" }
  );
}

export async function showBotAuthModal(interaction, botId) {
  const config = getGuildConfig(interaction.guildId);
  const mod = config.antiBot;
  const pending = mod.pending[botId];
  if (!pending || pending.deadline <= Date.now()) {
    return interaction.reply({ content: mod.passwordUnavailableMessage || "O prazo de autenticação expirou ou este bot não está em processo de autenticação.", ephemeral: true });
  }
  if (!passwordIsConfigured(mod)) {
    return interaction.reply({ content: mod.passwordNotConfiguredMessage || "A senha do Anti-Bot ainda não foi configurada pela administração.", ephemeral: true });
  }
  const modal = new ModalBuilder()
    .setCustomId(`futaba:bot-auth-submit:${botId}`)
    .setTitle("Autenticação de bot");
  const input = new TextInputBuilder()
    .setCustomId("auth_password")
    .setLabel("Senha de autenticação")
    .setPlaceholder("Digite a senha configurada pela administração")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(12)
    .setMaxLength(128);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

export async function submitBotAuth(client, interaction, botId) {
  const guild = interaction.guild;
  const config = getGuildConfig(guild.id);
  const mod = config.antiBot;
  const pending = mod.pending[botId];
  if (!pending || pending.deadline <= Date.now()) {
    return interaction.reply({ content: mod.passwordExpiredMessage || "O prazo de autenticação expirou. O procedimento de segurança foi encerrado.", ephemeral: true });
  }
  const password = interaction.fields.getTextInputValue("auth_password");
  const valid = await verifyPassword(password, mod.password);
  if (!valid) {
    pending.failedAttempts = Number(pending.failedAttempts || 0) + 1;
    await saveGuildConfig(guild.id, config);
    return interaction.reply({ content: mod.passwordIncorrectMessage || "Senha incorreta. A autenticação não foi concluída.", ephemeral: true });
  }

  const member = await guild.members.fetch(botId).catch(() => null);
  if (!member) {
    delete mod.pending[botId];
    await saveGuildConfig(guild.id, config);
    return interaction.reply({ content: mod.passwordBotMissingMessage || "O bot não está mais no servidor. O registro de autenticação foi encerrado.", ephemeral: true });
  }
  try {
    await member.timeout(null, "Autenticação do Anti-Bot concluída").catch(() => null);
    if (pending.quarantineRoleId && member.roles.cache.has(pending.quarantineRoleId)) {
      await member.roles.remove(pending.quarantineRoleId, "Autenticação do Anti-Bot concluída").catch(() => null);
    }
    const restorableRoles = (pending.originalRoleIds || []).filter(id => guild.roles.cache.has(id));
    if (restorableRoles.length) await member.roles.add(restorableRoles, "Restauração após autenticação do Anti-Bot").catch(() => null);
  } catch (error) {
    console.error(`[Futaba] Erro ao liberar bot autenticado: ${error.message}`);
  }
  delete mod.pending[botId];
  await saveGuildConfig(guild.id, config);

  const channel = await fetchTextChannel(client, pending.authChannelId);
  if (channel && pending.authMessageId) {
    const msg = await channel.messages.fetch(pending.authMessageId).catch(() => null);
    if (msg) {
      const embed = EmbedBuilder.from(msg.embeds[0] || new EmbedBuilder())
        .setColor(configuredSecurityColor(mod.authSuccessColor, 0x25C99A))
        .setTitle(mod.authSuccessTitle || "Autenticação concluída")
        .setDescription(mod.authSuccessDescription || "A senha foi validada. O bot foi liberado da quarentena.")
        .setTimestamp();
      await msg.edit({ embeds: [embed], components: [], allowedMentions: { parse: [] } }).catch(() => null);
    }
  }
  await notifySecurity(client, guild, "Anti-Bot", mod, "Autenticação concluída", "A senha foi validada e o bot foi liberado da quarentena.", { Bot: `${member.user.tag} (${member.id})`, "Autenticado por": `${interaction.user.tag} (${interaction.user.id})` });
  return interaction.reply({ content: mod.passwordSuccessMessage || "Autenticação concluída. O bot foi liberado da quarentena.", ephemeral: true });
}

async function expireBotAuth(client, guild, botId, pending) {
  const config = getGuildConfig(guild.id);
  const mod = config.antiBot;
  const current = mod.pending[botId];
  if (!current || current.deadline > Date.now()) return;
  const botMember = await guild.members.fetch(botId).catch(() => null);
  let banSucceeded = false;
  if (botMember) {
    try {
      await guild.members.ban(botId, { reason: "Bot não concluiu a autenticação obrigatória em cinco minutos." });
      banSucceeded = true;
    } catch (error) {
      console.error(`[Futaba] Não foi possível banir bot sem autenticação ${botId}: ${error.message}`);
    }
  }
  mod.blockedBotIds ||= [];
  if (!mod.blockedBotIds.includes(botId)) mod.blockedBotIds.push(botId);
  delete mod.pending[botId];
  await saveGuildConfig(guild.id, config);
  await notifySecurity(client, guild, "Anti-Bot", mod, "Prazo de autenticação expirado", "O bot não concluiu a autenticação em cinco minutos. Foi realizada uma tentativa de banimento.", {
    Bot: `${botId}`,
    Resultado: banSucceeded ? "Bot banido" : "Banimento não concluído; verifique hierarquia e permissões"
  });
  const channel = await fetchTextChannel(client, current.authChannelId);
  if (channel && current.authMessageId) {
    const msg = await channel.messages.fetch(current.authMessageId).catch(() => null);
    if (msg) {
      const embed = EmbedBuilder.from(msg.embeds[0] || new EmbedBuilder())
        .setColor(configuredSecurityColor(mod.authExpiredColor, 0xD94A62))
        .setTitle(mod.authExpiredTitle || "Prazo de autenticação expirado")
        .setDescription(banSucceeded ? (mod.authExpiredDescription || "A autenticação não foi concluída. O bot foi banido do servidor.") : (mod.authExpiredFailureDescription || "A autenticação não foi concluída. A tentativa de banimento falhou; a equipe foi notificada."))
        .setTimestamp();
      await msg.edit({ embeds: [embed], components: [], allowedMentions: { parse: [] } }).catch(() => null);
    }
  }
}

export async function processExpiredBotAuths(client) {
  for (const guild of client.guilds.cache.values()) {
    const config = getGuildConfig(guild.id);
    for (const [botId, pending] of Object.entries(config.antiBot.pending || {})) {
      if (pending.deadline <= Date.now()) await expireBotAuth(client, guild, botId, pending);
    }
  }
}

async function handleBotIntervention(client, guild, entry, config) {
  const intervention = detectProtectedBotIntervention(entry, config.antiBot, AuditLogEvent);
  if (!intervention) return false;

  const { botId, kind } = intervention;
  // Uma conta confiável nunca deve sofrer a escalada do Anti-Bot.
  if (isTrustedAntiBot(config.antiBot, botId)) return true;
  if (entry.executorId === client.user.id) return true;

  const actorId = entry.executorId || null;
  const actorIsOwner = actorId === guild.ownerId;
  let actorBanned = false;
  let actorBanResult = actorIsOwner
    ? "Não executado: o proprietário do servidor não pode ser banido pelo bot"
    : actorId
      ? "Falhou ou sem permissão"
      : "Não executado: Discord não informou o responsável no registro de auditoria";
  let botBanned = false;
  let actorLabel = actorId ? `<@${actorId}> (${actorId})` : "Não identificado";
  let botLabel = botId;

  if (actorId) {
    const actorMember = await guild.members.fetch(actorId).catch(() => null);
    if (actorMember?.user) actorLabel = `${actorMember.user.tag} (${actorId})`;
  }
  const botMember = await guild.members.fetch(botId).catch(() => null);
  if (botMember?.user) botLabel = `${botMember.user.tag} (${botId})`;

  // Primeiro tenta remover do servidor a conta que interferiu; em seguida, o bot protegido.
  if (actorId && !actorIsOwner && actorId !== botId) {
    try {
      await guild.members.ban(actorId, {
        reason: `Anti-Bot: ${kind} durante a quarentena de ${botId}.`
      });
      actorBanned = true;
      actorBanResult = "Banimento realizado";
    } catch (error) {
      actorBanResult = `Não concluído: ${error.message}`;
      console.error(`[Futaba] Não foi possível banir o responsável ${actorId}: ${error.message}`);
    }
  }

  try {
    await guild.members.ban(botId, {
      reason: `Anti-Bot: ${kind}. Bot em quarentena não pode ter o isolamento removido.`
    });
    botBanned = true;
  } catch (error) {
    console.error(`[Futaba] Não foi possível (re)banir o bot ${botId}: ${error.message}`);
  }

  config.antiBot.blockedBotIds ||= [];
  if (!config.antiBot.blockedBotIds.includes(botId)) config.antiBot.blockedBotIds.push(botId);
  delete config.antiBot.pending[botId];
  await saveGuildConfig(guild.id, config);

  const botBanResult = botBanned
    ? "Banimento realizado"
    : "Não concluído: verifique permissão Banir membros e hierarquia de cargos";
  await notifySecurity(
    client,
    guild,
    "Anti-Bot",
    config.antiBot,
    "Tentativa de violação da quarentena detectada",
    `O Anti-Bot detectou ${kind}. A Futaba tentou banir o responsável pela alteração e o bot protegido.`,
    {
      Bot: botLabel,
      "Administrador responsável": actorLabel,
      "Intervenção detectada": kind,
      "Banimento do responsável": actorBanResult,
      "Banimento do bot": botBanResult,
      "Proprietário do servidor": actorIsOwner ? "Sim — o Discord não permite que a Futaba o bana" : "Não",
      "Evento de auditoria": String(entry.action),
      "ID do registro": entry.id || "Indisponível"
    }
  );

  if (!actorBanned && actorId && !actorIsOwner) {
    console.error(`[Futaba] O responsável ${actorId} não foi banido; consulte o alerta do Anti-Bot para a causa.`);
  }
  return true;
}

const DESTRUCTIVE_ACTIONS = new Set([
  AuditLogEvent.ChannelDelete,
  AuditLogEvent.RoleDelete,
  AuditLogEvent.ChannelOverwriteCreate,
  AuditLogEvent.ChannelOverwriteDelete,
  AuditLogEvent.ChannelOverwriteUpdate,
  AuditLogEvent.RoleUpdate,
  AuditLogEvent.WebhookDelete,
  AuditLogEvent.GuildUpdate,
  AuditLogEvent.MemberBanAdd,
  AuditLogEvent.MemberKick
]);

async function handleAntiNuke(client, guild, entry, config) {
  const mod = config.antiNuke;
  if (!mod.enabled || !DESTRUCTIVE_ACTIONS.has(entry.action)) return;
  const actionName = Object.entries(AuditLogEvent).find(([name, value]) => name && value === entry.action)?.[0];
  if (Array.isArray(mod.monitoredAuditActions) && actionName && !mod.monitoredAuditActions.includes(actionName)) return;
  const actorId = entry.executorId;
  if (!actorId || actorId === client.user.id) return;
  const windowMs = Math.max(1000, Number(mod.windowSeconds || 12) * 1000);
  const key = `${guild.id}:${actorId}`;
  const events = (nukeActions.get(key) || []).filter(time => Date.now() - time < windowMs);
  events.push(Date.now());
  nukeActions.set(key, events);
  const limit = Math.max(2, Number(mod.actionLimit || 3));
  if (events.length < limit) return;
  nukeActions.set(key, []);

  const isOwner = actorId === guild.ownerId;
  let banSucceeded = false;
  if (mod.autoBanAdmin && !isOwner) {
    try {
      await guild.members.ban(actorId, { reason: `Anti-Nuke: ${events.length} ações destrutivas em ${mod.windowSeconds} segundos.` });
      banSucceeded = true;
    } catch (error) {
      console.error(`[Futaba] Falha ao banir executor Anti-Nuke ${actorId}: ${error.message}`);
    }
  }
  await sendPublicNotice(client, null, mod, mod.publicMessage, {
    user: actorId,
    type: "sequência destrutiva confirmada",
    action: isOwner ? "proprietário não pode ser banido pela Futaba" : banSucceeded ? "responsável banido" : "tentativa de banimento não concluída"
  }, "danger");
  await notifySecurity(client, guild, "Anti-Nuke", mod, "Sequência destrutiva confirmada",
    "Uma sequência de operações administrativas de alto risco ultrapassou o limite configurado.", {
      Executor: actorId,
      "Quantidade de eventos": events.length,
      "Janela de detecção": `${mod.windowSeconds} segundos`,
      "Última ação": actionName || String(entry.action),
      "Banimento automático": isOwner ? "Impossível: executor é o proprietário" : banSucceeded ? "Executado" : mod.autoBanAdmin ? "Falhou ou sem permissão" : "Desativado"
    });
}

export async function handleAuditLogEntry(client, entry, guild) {
  if (!guild || !entry) return;
  const config = getGuildConfig(guild.id);
  try {
    // A política do Anti-Bot tem prioridade sobre o contador do Anti-Nuke.
    const interventionAction = [
      AuditLogEvent.MemberUpdate,
      AuditLogEvent.MemberRoleUpdate,
      AuditLogEvent.RoleUpdate,
      AuditLogEvent.MemberBanRemove,
      AuditLogEvent.ChannelOverwriteCreate,
      AuditLogEvent.ChannelOverwriteUpdate,
      AuditLogEvent.ChannelOverwriteDelete
    ].includes(entry.action);
    if (config.antiBot.enabled && interventionAction) {
      const handled = await handleBotIntervention(client, guild, entry, config);
      if (handled) return;
    }
    await handleAntiNuke(client, guild, entry, config);
  } catch (error) {
    console.error(`[Futaba] Erro ao analisar audit log: ${error.stack || error.message}`);
  }
}

export async function handleGuildMemberAdd(client, member) {
  if (member.user.bot) {
    await quarantineBot(client, member);
    return;
  }
  const config = getGuildConfig(member.guild.id);
  const mod = config.antiRaid;
  if (!mod.enabled) return;
  const now = Date.now();
  const windowMs = Math.max(1000, Number(mod.windowSeconds || 15) * 1000);
  const previous = (raidJoins.get(member.guild.id) || []).filter(item => now - item.at <= windowMs);
  previous.push({ userId: member.id, at: now });
  raidJoins.set(member.guild.id, previous);
  if (previous.length < Number(mod.joinLimit || 8) || mod.lockdownUntil > now) return;

  const duration = Math.max(1, Number(mod.lockdownMinutes || 10)) * 60 * 1000;
  mod.verificationLevelBeforeLockdown = member.guild.verificationLevel;
  mod.lockdownUntil = now + duration;
  await saveGuildConfig(member.guild.id, config);
  try {
    await member.guild.setVerificationLevel(GuildVerificationLevel.VeryHigh, "Anti-Raid: sequência rápida de entradas detectada");
  } catch (error) {
    console.error(`[Futaba] Falha ao elevar verificação do servidor: ${error.message}`);
  }
  await sendPublicNotice(client, null, mod, mod.publicMessage, { type: "padrão anormal de entradas", action: "verificação temporariamente elevada" }, "danger");
  await notifySecurity(client, member.guild, "Anti-Raid", mod, "Padrão de entradas em massa detectado",
    "A quantidade de entradas em curto intervalo ultrapassou o limite configurado. O nível de verificação do servidor foi temporariamente elevado.", {
      "Entradas detectadas": previous.length,
      "Janela": `${mod.windowSeconds} segundos`,
      "Duração da proteção": `${mod.lockdownMinutes} minutos`
    });
}

export async function restoreExpiredRaidLockdowns(client) {
  for (const guild of client.guilds.cache.values()) {
    const config = getGuildConfig(guild.id);
    const mod = config.antiRaid;
    if (!mod.lockdownUntil || mod.lockdownUntil > Date.now()) continue;
    const previous = mod.verificationLevelBeforeLockdown;
    try {
      if (previous !== null && previous !== undefined) {
        await guild.setVerificationLevel(previous, "Fim da proteção temporária Anti-Raid da Futaba Sakura");
      }
    } catch (error) {
      console.error(`[Futaba] Não foi possível restaurar o nível de verificação de ${guild.name}: ${error.message}`);
      continue; // Mantém o estado para tentar restaurar novamente na próxima verificação.
    }
    mod.lockdownUntil = null;
    mod.verificationLevelBeforeLockdown = null;
    await saveGuildConfig(guild.id, config);
  }
}

export async function handleFutabaSecurityButton(interaction) {
  const [, action, botId] = interaction.customId.split(":");
  if (action === "bot-auth") return showBotAuthModal(interaction, botId);
  return false;
}

export async function handleFutabaSecurityModal(client, interaction) {
  const [, action, botId] = interaction.customId.split(":");
  if (action === "bot-auth-submit") return submitBotAuth(client, interaction, botId);
  return false;
}
