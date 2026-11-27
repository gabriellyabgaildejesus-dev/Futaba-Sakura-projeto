import {
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField
} from "discord.js";
import { getGuildConfig, saveGuildConfig } from "./store.js";
import { safeHttpsUrl, clip, renderTemplate } from "./security-utils.js";
import { parseMemberId, parseDuration, clearMessages } from "./moderation-command-utils.js";

const MAX_CLEAR = 1000;

function hasPermission(member, permission) {
  return Boolean(member?.permissions?.has?.(permission));
}

function formatDuration(seconds) {
  if (!seconds) return "—";
  const units = [[86400, "d"], [3600, "h"], [60, "min"], [1, "s"]];
  let remaining = seconds;
  const out = [];
  for (const [size, label] of units) {
    const amount = Math.floor(remaining / size);
    if (amount) out.push(`${amount}${label}`);
    remaining %= size;
  }
  return out.join(" ") || "0s";
}

function getReason(text, fallback = "Não informado") {
  const reason = String(text || "").trim();
  return clip(reason || fallback, 450);
}

function getTargetId(args) {
  return parseMemberId(args[0] || "");
}

function makeRecord({ userId, username, type, moderatorId, moderatorTag, reason, durationSeconds = null, status = "active", channelId = null, extra = {} }) {
  const now = new Date().toISOString();
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    username: username || userId,
    type,
    moderatorId,
    moderatorTag,
    reason,
    durationSeconds,
    status,
    createdAt: now,
    expiresAt: durationSeconds ? new Date(Date.now() + durationSeconds * 1000).toISOString() : null,
    removedAt: null,
    removedBy: null,
    channelId,
    ...extra
  };
}

async function saveRecord(guildId, record) {
  const config = getGuildConfig(guildId);
  config.moderationHistory ||= [];
  config.moderationHistory.push(record);
  // Mantém o histórico completo, com limite defensivo para não exceder o armazenamento JSON.
  if (config.moderationHistory.length > 20_000) config.moderationHistory.splice(0, config.moderationHistory.length - 20_000);
  await saveGuildConfig(guildId, config);
  return record;
}

function punishmentEmbed(record, general) {
  const settings = general?.punishmentEmbed || {};
  const colorText = /^#[0-9a-f]{6}$/i.test(settings.color || "") ? settings.color : "#FF963F";
  const templateValues = { type: record.type, user: record.username, userId: record.userId, moderator: record.moderatorTag, moderatorId: record.moderatorId, reason: record.reason, duration: record.durationSeconds ? formatDuration(record.durationSeconds) : "Permanente" };
  const embed = new EmbedBuilder()
    .setColor(Number.parseInt(colorText.slice(1), 16))
    .setTitle(clip(renderTemplate(settings.title || "⚖️ O veredito foi declarado!", templateValues), 256))
    .setDescription(clip(renderTemplate(settings.description || "O juiz declarou que a sentença é:", templateValues), 4000));
  if (settings.author) embed.setAuthor({ name: clip(renderTemplate(settings.author, templateValues), 256), ...(safeHttpsUrl(settings.authorIconUrl) ? { iconURL: safeHttpsUrl(settings.authorIconUrl) } : {}) });
  if (settings.timestamp !== false) embed.setTimestamp(new Date(record.createdAt));
  if (settings.footer) embed.setFooter({ text: clip(renderTemplate(settings.footer, templateValues), 2048), ...(safeHttpsUrl(settings.footerIconUrl) ? { iconURL: safeHttpsUrl(settings.footerIconUrl) } : {}) });
  if (settings.includeDefaultFields !== false) embed.addFields(
      { name: "Sentença", value: clip(record.type, 1024), inline: true },
      { name: "Membro", value: `<@${record.userId}>\n\`${record.username}\``, inline: true },
      { name: "Moderador", value: `<@${record.moderatorId}>\n\`${record.moderatorTag}\``, inline: true },
      { name: "Motivo", value: clip(record.reason, 1024) },
      { name: "Duração", value: record.durationSeconds ? formatDuration(record.durationSeconds) : "Permanente / sem duração" , inline: true },
      { name: "Estado", value: record.status === "active" ? "Ativa" : record.status === "expired" ? "Expirada" : "Removida", inline: true },
      { name: "Data e horário", value: `<t:${Math.floor(new Date(record.createdAt).getTime() / 1000)}:F>` }
    );
  for (const line of Array.isArray(settings.fields) ? settings.fields : []) {
    if (embed.data.fields.length >= 25) break;
    const parts = String(line).split("|");
    const name = renderTemplate(parts.shift()?.trim() || "", templateValues);
    const value = renderTemplate(parts.shift()?.trim() || "", templateValues);
    const inline = String(parts.shift() || "false").trim().toLowerCase() === "true";
    if (name && value) embed.addFields({ name: clip(name, 256), value: clip(value, 1024), inline });
  }
  const image = safeHttpsUrl(settings.imageUrl);
  const thumbnail = safeHttpsUrl(settings.thumbnailUrl);
  if (image) embed.setImage(image);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

export async function logPunishment(client, guild, record) {
  const general = getGuildConfig(guild.id).general || {};
  const channelId = general.logChannelId;
  if (!channelId) return false;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.messages) return false;
  try {
    await channel.send({ embeds: [punishmentEmbed(record, general)], allowedMentions: { parse: [], users: [record.userId, record.moderatorId] } });
    return true;
  } catch (error) {
    console.error(`[Futaba] Falha no registro de punição: ${error.message}`);
    return false;
  }
}

async function recordAction(client, message, data) {
  const record = makeRecord({
    userId: data.userId,
    username: data.username,
    type: data.type,
    moderatorId: message.author.id,
    moderatorTag: message.author.tag,
    reason: data.reason,
    durationSeconds: data.durationSeconds,
    status: data.status,
    channelId: message.channel.id,
    extra: data.extra
  });
  await saveRecord(message.guildId, record);
  await logPunishment(client, message.guild, record);
  return record;
}

async function updateActiveRecords(guildId, userId, types, moderatorId) {
  const config = getGuildConfig(guildId);
  const matches = (config.moderationHistory || []).filter(record =>
    record.userId === userId && types.includes(record.type) && record.status === "active"
  );
  const latest = matches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!latest) return null;
  latest.status = "removed";
  latest.removedAt = new Date().toISOString();
  latest.removedBy = moderatorId;
  await saveGuildConfig(guildId, config);
  return latest;
}

async function resolveMember(guild, id) {
  return guild.members.fetch(id).catch(() => null);
}

async function reply(message, content, options = {}) {
  return message.reply({ content: clip(content, 1900), allowedMentions: { parse: [], repliedUser: false }, ...options });
}

function isTextChannel(channel) {
  return Boolean(channel?.isTextBased?.() && channel.messages && channel.permissionOverwrites);
}

async function runBan(client, message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.BanMembers)) return reply(message, "Você precisa da permissão **Banir membros**.");
  const userId = getTargetId(args);
  if (!userId) return reply(message, "Uso: `!ban @membro [motivo]` ou `!ban ID [motivo]`.");
  const target = await resolveMember(message.guild, userId);
  if (target && (!target.bannable || target.id === message.guild.ownerId)) return reply(message, "Não posso banir esse membro por causa da hierarquia ou das permissões do Discord.");
  const reason = getReason(args.slice(1).join(" "));
  try {
    await message.guild.members.ban(userId, { reason: `Futaba • ${message.author.tag}: ${reason}`, deleteMessageSeconds: 0 });
    const record = await recordAction(client, message, { userId, username: target?.user?.tag || userId, type: "Banimento", reason });
    return reply(message, `⚖️ <@${userId}> foi banido. Registro: \`${record.id}\`.`);
  } catch (error) {
    return reply(message, `Não foi possível banir o membro: ${error.message}`);
  }
}

async function runUnban(client, message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.BanMembers)) return reply(message, "Você precisa da permissão **Banir membros**.");
  const userId = getTargetId(args);
  if (!userId) return reply(message, "Uso: `!unban ID [motivo]`.");
  const reason = getReason(args.slice(1).join(" "));
  try {
    await message.guild.members.unban(userId, `Futaba • ${message.author.tag}: ${reason}`);
    const record = await updateActiveRecords(message.guildId, userId, ["Banimento"], message.author.id);
    if (record) await logPunishment(client, message.guild, record);
    return reply(message, `O banimento de <@${userId}> foi removido.${record ? ` Registro atualizado: \`${record.id}\`.` : " Não encontrei um registro ativo correspondente."}`);
  } catch (error) {
    return reply(message, `Não foi possível remover o banimento: ${error.message}`);
  }
}

async function runKick(client, message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.KickMembers)) return reply(message, "Você precisa da permissão **Expulsar membros**.");
  const userId = getTargetId(args);
  if (!userId) return reply(message, "Uso: `!kick @membro [motivo]`.");
  const target = await resolveMember(message.guild, userId);
  if (!target) return reply(message, "Esse membro não está no servidor.");
  if (!target.kickable) return reply(message, "Não posso expulsar esse membro por causa da hierarquia ou das permissões do Discord.");
  const reason = getReason(args.slice(1).join(" "));
  try {
    await target.kick(`Futaba • ${message.author.tag}: ${reason}`);
    const record = await recordAction(client, message, { userId, username: target.user.tag, type: "Expulsão", reason });
    return reply(message, `👢 <@${userId}> foi expulso. Registro: \`${record.id}\`.`);
  } catch (error) {
    return reply(message, `Não foi possível expulsar o membro: ${error.message}`);
  }
}

async function runMute(client, message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, "Você precisa da permissão **Moderar membros**.");
  const userId = getTargetId(args);
  if (!userId) return reply(message, "Uso: `!mute @membro 10m [motivo]`. Duração máxima: 28 dias.");
  const target = await resolveMember(message.guild, userId);
  if (!target) return reply(message, "Esse membro não está no servidor.");
  if (!target.moderatable || target.id === message.guild.ownerId) return reply(message, "Não posso aplicar timeout nesse membro por causa da hierarquia/permissões.");
  const durationToken = args[1] || "";
  const explicitDuration = parseDuration(durationToken);
  const looksLikeDuration = /^\d+[smhd]$/i.test(durationToken);
  if (looksLikeDuration && !explicitDuration) return reply(message, "Duração inválida. Use `30s`, `10m`, `2h` ou `7d` (máximo 28d).");
  const duration = explicitDuration || 600;
  const reason = getReason(args.slice(explicitDuration ? 2 : 1).join(" "));
  try {
    await target.timeout(duration * 1000, `Futaba • ${message.author.tag}: ${reason}`);
    const record = await recordAction(client, message, { userId, username: target.user.tag, type: "Silenciamento", reason, durationSeconds: duration });
    return reply(message, `🔇 <@${userId}> recebeu timeout por ${formatDuration(duration)}. Registro: \`${record.id}\`.`);
  } catch (error) {
    return reply(message, `Não foi possível aplicar timeout: ${error.message}`);
  }
}

async function runUnmute(client, message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, "Você precisa da permissão **Moderar membros**.");
  const userId = getTargetId(args);
  if (!userId) return reply(message, "Uso: `!unmute @membro`.");
  const target = await resolveMember(message.guild, userId);
  if (!target) return reply(message, "Esse membro não está no servidor.");
  if (!target.moderatable) return reply(message, "Não posso remover o timeout desse membro por causa da hierarquia.");
  try {
    await target.timeout(null, `Futaba • timeout removido por ${message.author.tag}`);
    const record = await updateActiveRecords(message.guildId, userId, ["Silenciamento"], message.author.id);
    if (record) await logPunishment(client, message.guild, record);
    return reply(message, `🔊 Timeout removido de <@${userId}>.${record ? ` Registro atualizado: \`${record.id}\`.` : " Nenhum registro ativo correspondente foi encontrado."}`);
  } catch (error) {
    return reply(message, `Não foi possível remover o timeout: ${error.message}`);
  }
}

async function runWarn(client, message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, "Você precisa da permissão **Moderar membros**.");
  const userId = getTargetId(args);
  if (!userId) return reply(message, "Uso: `!warn @membro [motivo]`.");
  const target = await resolveMember(message.guild, userId);
  if (!target) return reply(message, "Esse membro não está no servidor.");
  const reason = getReason(args.slice(1).join(" "));
  const record = await recordAction(client, message, { userId, username: target.user.tag, type: "Advertência", reason });
  await target.send({ content: `Você recebeu uma advertência em **${message.guild.name}**. Motivo: ${reason}`, allowedMentions: { parse: [] } }).catch(() => null);
  return reply(message, `⚠️ Advertência registrada para <@${userId}>. Registro: \`${record.id}\`.`);
}

async function runUnwarn(client, message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, "Você precisa da permissão **Moderar membros**.");
  const userId = getTargetId(args);
  if (!userId) return reply(message, "Uso: `!unwarn @membro`.");
  const record = await updateActiveRecords(message.guildId, userId, ["Advertência"], message.author.id);
  if (!record) return reply(message, "Não encontrei advertências ativas para esse membro.");
  await logPunishment(client, message.guild, record);
  return reply(message, `A advertência \`${record.id}\` de <@${userId}> foi marcada como removida.`);
}

async function runHistory(message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.ModerateMembers)) return reply(message, "Você precisa da permissão **Moderar membros**.");
  const userId = getTargetId(args);
  if (!userId) return reply(message, "Uso: `!punições @membro [página]`.");
  const config = getGuildConfig(message.guildId);
  const now = Date.now();
  let historyChanged = false;
  for (const item of config.moderationHistory || []) {
    if (item.status === "active" && item.expiresAt && new Date(item.expiresAt).getTime() <= now) {
      item.status = "expired";
      historyChanged = true;
    }
  }
  if (historyChanged) await saveGuildConfig(message.guildId, config);
  const records = (config.moderationHistory || []).filter(item => item.userId === userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (!records.length) return reply(message, `Não há registros de punição para <@${userId}>.`);
  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(records.length / pageSize));
  const requested = Number(args[1] || 1);
  const page = Number.isInteger(requested) && requested > 0 ? Math.min(requested, pages) : 1;
  const embed = new EmbedBuilder().setColor(0xFF963F).setTitle(`📚 Histórico de punições • ${records[0].username}`)
    .setDescription(`Membro: <@${userId}> (\`${userId}\`)\nRegistros: **${records.length}** · Página **${page}/${pages}**`)
    .setFooter({ text: "POOL Party Moderation • Registros preservados após a saída do membro" });
  for (const [index, item] of records.slice((page - 1) * pageSize, page * pageSize).entries()) {
    const status = item.status === "active" ? "Ativa" : item.status === "expired" ? "Expirada" : "Removida";
    const date = new Date(item.createdAt);
    embed.addFields({ name: `${(page - 1) * pageSize + index + 1}. ${item.type} • ${status}`, value: `**Data:** <t:${Math.floor(date.getTime() / 1000)}:f>\n**Moderador:** <@${item.moderatorId}>\n**Motivo:** ${clip(item.reason, 400)}${item.durationSeconds ? `\n**Duração:** ${formatDuration(item.durationSeconds)}` : ""}${item.removedAt ? `\n**Removida:** <t:${Math.floor(new Date(item.removedAt).getTime() / 1000)}:f>` : ""}\n**ID:** \`${item.id}\``, inline: false });
  }
  return message.reply({ embeds: [embed], allowedMentions: { parse: [], users: [userId] } });
}

async function logChannelAction(client, guild, action, channelId, actorId, logChannelId) {
  if (!logChannelId) return false;
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;
  try {
    await channel.send({ embeds: [new EmbedBuilder().setColor(0xFF963F).setTitle(`🔐 ${action}`).addFields(
      { name: "Canal", value: `<#${channelId}> (\`${channelId}\`)`, inline: true },
      { name: "Responsável", value: `<@${actorId}> (\`${actorId}\`)`, inline: true },
      { name: "Servidor", value: guild.name, inline: true }
    ).setTimestamp()], allowedMentions: { parse: [] } });
    return true;
  } catch { return false; }
}

async function runLock(message) {
  if (!hasPermission(message.member, PermissionFlagsBits.ManageChannels)) return reply(message, "Você precisa da permissão **Gerenciar canais**.");
  if (!isTextChannel(message.channel)) return reply(message, "Este canal não permite bloqueio de mensagens.");
  const config = getGuildConfig(message.guildId);
  config.channelLocks ||= {};
  if (config.channelLocks[message.channel.id]?.locked) return reply(message, "Este canal já está bloqueado pela Futaba.");
  if (!message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.ManageChannels)) return reply(message, "A Futaba precisa da permissão **Gerenciar canais**.");
  const changedIds = new Set([message.guild.id, message.client.user.id]);
  for (const role of message.guild.roles.cache.values()) {
    if (role.id === message.guild.id) continue;
    if (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageMessages)) changedIds.add(role.id);
  }
  const snapshot = {};
  for (const id of changedIds) {
    const overwrite = message.channel.permissionOverwrites.cache.get(id);
    snapshot[id] = overwrite ? { exists: true, allow: overwrite.allow.bitfield.toString(), deny: overwrite.deny.bitfield.toString() } : { exists: false };
  }
  try {
    await message.channel.permissionOverwrites.edit(message.guild.id, { SendMessages: false, SendMessagesInThreads: false }, { reason: `Canal bloqueado por ${message.author.tag}` });
    for (const id of [...changedIds].filter(id => id !== message.guild.id)) {
      await message.channel.permissionOverwrites.edit(id, { SendMessages: true, SendMessagesInThreads: true }, { reason: "Preservar acesso da equipe e da Futaba durante o bloqueio" }).catch(() => null);
    }
    config.channelLocks[message.channel.id] = { locked: true, lockedAt: new Date().toISOString(), lockedBy: message.author.id, snapshot };
    await saveGuildConfig(message.guildId, config);
    await logChannelAction(message.client, message.guild, "Canal bloqueado", message.channel.id, message.author.id, config.general?.logChannelId);
    await message.channel.send({ content: `🔒 Canal bloqueado por <@${message.author.id}>.`, allowedMentions: { parse: [], users: [message.author.id] } });
  } catch (error) {
    return reply(message, `Não consegui bloquear o canal: ${error.message}`);
  }
}

async function runUnlock(message) {
  if (!hasPermission(message.member, PermissionFlagsBits.ManageChannels)) return reply(message, "Você precisa da permissão **Gerenciar canais**.");
  const config = getGuildConfig(message.guildId);
  const lock = config.channelLocks?.[message.channel.id];
  if (!lock?.locked) return reply(message, "Este canal não possui um bloqueio da Futaba para restaurar.");
  if (!message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.ManageChannels)) return reply(message, "A Futaba precisa da permissão **Gerenciar canais**.");
  try {
    for (const [id, before] of Object.entries(lock.snapshot || {})) {
      if (before.exists) {
        await message.channel.permissionOverwrites.edit(id, { allow: BigInt(before.allow), deny: BigInt(before.deny) }, { reason: `Bloqueio removido por ${message.author.tag}` });
      } else {
        await message.channel.permissionOverwrites.delete(id, `Restaurar permissões antes do bloqueio por ${message.author.tag}`).catch(() => null);
      }
    }
    lock.locked = false;
    lock.unlockedAt = new Date().toISOString();
    lock.unlockedBy = message.author.id;
    await saveGuildConfig(message.guildId, config);
    await logChannelAction(message.client, message.guild, "Canal desbloqueado", message.channel.id, message.author.id, config.general?.logChannelId);
    await message.channel.send({ content: `🔓 Canal desbloqueado por <@${message.author.id}>.`, allowedMentions: { parse: [], users: [message.author.id] } });
  } catch (error) {
    return reply(message, `Não consegui restaurar as permissões do canal: ${error.message}`);
  }
}

async function runClear(message, args) {
  if (!hasPermission(message.member, PermissionFlagsBits.ManageMessages)) return reply(message, "Você precisa da permissão **Gerenciar mensagens**.");
  if (!message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) return reply(message, "A Futaba precisa da permissão **Gerenciar mensagens** neste canal.");
  let count = null;
  let targetId = null;
  if (/^\d+$/.test(args[0] || "")) {
    count = Number(args[0]);
    targetId = parseMemberId(args[1] || "");
  } else if (args[0]) {
    targetId = parseMemberId(args[0]);
  }
  const config = getGuildConfig(message.guildId);
  if (!count) count = targetId ? Number(config.general?.defaultClearCount || 50) : null;
  if (!count) return reply(message, "Uso: `!clear 50`, `!clear 50 @membro` ou `!clear @membro`. Informe uma quantidade entre 1 e 1000.");
  if (!Number.isInteger(count) || count < 1 || count > MAX_CLEAR) return reply(message, "A quantidade deve ser um número inteiro entre 1 e 1000.");
  if (args[1] && !/^\d+$/.test(args[0] || "") && !targetId) return reply(message, "Membro inválido. Use uma menção ou ID.");
  const result = await clearMessages(message.channel, count, targetId);
  const configNow = getGuildConfig(message.guildId);
  const logChannelId = configNow.general?.logChannelId;
  if (logChannelId) {
    const logChannel = await message.client.channels.fetch(logChannelId).catch(() => null);
    if (logChannel?.isTextBased?.()) await logChannel.send({ embeds: [new EmbedBuilder().setColor(0xFF963F).setTitle("🧹 Limpeza de mensagens").addFields(
      { name: "Moderador", value: `<@${message.author.id}> (${message.author.id})`, inline: true },
      { name: "Canal", value: `${message.channel} (${message.channel.id})`, inline: true },
      { name: "Filtro", value: targetId ? `<@${targetId}>` : "Todos os membros", inline: true },
      { name: "Solicitadas", value: String(result.requested), inline: true },
      { name: "Encontradas", value: String(result.matched), inline: true },
      { name: "Excluídas", value: String(result.deleted), inline: true },
      { name: "Falhas/limites", value: String(result.failed), inline: true }
    ).setTimestamp()], allowedMentions: { parse: [] } }).catch(() => null);
  }
  return message.channel.send({ content: `🧹 Limpeza concluída: **${result.deleted}** mensagem(ns) excluída(s) de **${result.matched}** encontrada(s). ${result.failed ? `${result.failed} falharam (permissão, idade ou limite do Discord).` : ""}`, allowedMentions: { parse: [] } });
}

const HANDLERS = {
  ban: runBan,
  unban: runUnban,
  kick: runKick,
  mute: runMute,
  unmute: runUnmute,
  warn: runWarn,
  unwarn: runUnwarn,
  punições: runHistory,
  punicoes: runHistory,
  lock: runLock,
  unlock: runUnlock,
  clear: runClear
};

export async function handleModerationCommand(client, message) {
  if (!message.guild || message.author?.bot || message.webhookId || typeof message.content !== "string") return false;
  const config = getGuildConfig(message.guildId);
  const prefix = config.general?.prefix || "!";
  if (!message.content.startsWith(prefix)) return false;
  const parts = message.content.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  const name = parts.shift().toLocaleLowerCase("pt-BR");
  const handler = HANDLERS[name];
  if (!handler) return false;
  try {
    await handler(client, message, parts);
  } catch (error) {
    console.error(`[Futaba] Falha no comando !${name}: ${error.stack || error.message}`);
    await reply(message, `O comando falhou: ${error.message}`);
  }
  return true;
}
