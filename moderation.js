import { handleModerationCommand } from "./moderation-commands.js";
import { getGuildConfig, saveGuildConfig } from "./store.js";
import { getMessageSignature, isWatched, normalizeText, normalizeAutoModText } from "./security-utils.js";
import { classifyLinks, hasAuthorizedLinkRole } from "./links.js";
import { reportViolation, sendModuleLog } from "./notifications.js";
import { purgeMemberMessagesInWindow } from "./message-cleanup.js";
import { applyConfiguredTimeout, describeTimeoutResult } from "./punishments.js";

const histories = new Map();
const autoModWordCache = new WeakMap();

function findAutoModTerm(words, normalizedMessage) {
  if (!Array.isArray(words) || !words.length || !normalizedMessage) return null;
  let compiled = autoModWordCache.get(words);
  if (!compiled) {
    compiled = words
      .map(original => ({ original, normalized: normalizeAutoModText(original) }))
      // Emoji-only entries are ignored: emoji must never act as prohibited words.
      .filter(item => item.normalized)
      .map(item => ({ ...item, pattern: new RegExp(`(?:^| )${item.normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$| )`, "u") }));
    autoModWordCache.set(words, compiled);
  }
  return compiled.find(item => item.pattern.test(normalizedMessage))?.original || null;
}

function remember(key, value, windowMs) {
  const now = Date.now();
  const list = histories.get(key) || [];
  const filtered = list.filter(item => now - item.at <= windowMs);
  filtered.push({ ...value, at: now });
  histories.set(key, filtered);
  return filtered;
}

function countEmoji(value) {
  const text = String(value || "");
  const unicodeEmoji = [...text.matchAll(/\p{Extended_Pictographic}/gu)].length;
  const customEmoji = [...text.matchAll(/<a?:[a-zA-Z0-9_]{2,32}:\d{17,20}>/g)].length;
  return unicodeEmoji + customEmoji;
}

function countMentions(message) {
  // Conta ocorrências no texto, inclusive quando a mesma pessoa/cargo é repetido.
  return [...String(message.content || "").matchAll(/<@!?\d{17,20}>|<@&\d{17,20}>|@everyone|@here/g)].length;
}

async function deleteMessageImmediately(message, enabled = true) {
  if (!enabled) return false;
  try {
    await message.delete();
    return true;
  } catch (error) {
    console.error(`[Futaba] Não foi possível excluir a mensagem ${message.id}: ${error.message}`);
    return false;
  }
}

function scheduleMemberWindowCleanup(client, message, moduleKey, moduleConfig, windowSeconds, enabled) {
  const delaySeconds = Math.max(0, Number(moduleConfig.deleteDelaySeconds) || 0);
  if (!enabled || delaySeconds === 0) {
    return { scheduled: false, reason: enabled ? "atraso 0" : "exclusão desativada" };
  }

  const timer = setTimeout(async () => {
    try {
      const result = await purgeMemberMessagesInWindow(message, windowSeconds);
      await sendModuleLog(client, message.guild, moduleKey, "Limpeza do período concluída", {
        user: message.author.tag,
        userId: message.author.id,
        channel: `#${message.channel.name} (${message.channel.id})`,
        content: "Mensagens do membro dentro da janela de detecção",
        infraction: "Limpeza de mensagens após infração",
        action: `${result.deletedCount} mensagem(ns) excluída(s); ${result.failedCount} falha(s); ${result.matchedCount} encontrada(s)`
      }, moduleConfig);
      if (result.failedCount > 0) {
        console.warn(`[Futaba] ${moduleKey}: ${result.failedCount} mensagem(ns) do membro ${message.author.id} não puderam ser apagadas.`);
      }
    } catch (error) {
      console.error(`[Futaba] Falha ao limpar o período de ${moduleKey} para ${message.author.id}: ${error.stack || error.message}`);
      await sendModuleLog(client, message.guild, moduleKey, "Falha na limpeza do período", {
        user: message.author.tag,
        userId: message.author.id,
        channel: `#${message.channel.name} (${message.channel.id})`,
        infraction: "Limpeza de mensagens após infração",
        action: `Falha ao buscar ou excluir mensagens: ${error.message}`
      }, moduleConfig);
    }
  }, delaySeconds * 1000);
  timer.unref?.();
  return { scheduled: true, delaySeconds, windowSeconds };
}

async function applySpamTimeout(message, durationSeconds, moduleName) {
  return applyConfiguredTimeout(message, durationSeconds, moduleName);
}

async function handleAutoMod(client, message, config) {
  const mod = config.autoMod;
  if (!mod.enabled || !isWatched(mod, message.channelId)) return;
  const normalized = normalizeAutoModText(message.content);
  const found = findAutoModTerm(mod.words, normalized);
  if (!found) return;
  const deleted = await deleteMessageImmediately(message, mod.deleteMessage);
  await reportViolation({
    client, message, guild: message.guild, moduleKey: "AutoMod", moduleConfig: mod,
    infraction: `Palavra ou expressão proibida detectada: ${found}`,
    action: deleted ? "Mensagem removida" : mod.deleteMessage ? "Remoção não concluída (verifique Manage Messages)" : "Exclusão desativada",
    staffAlert: Boolean(mod.staffChannelId)
  });
}

async function handleAntiLink(client, message, config) {
  const mod = config.antiLink;
  if (!mod.enabled || !isWatched(mod, message.channelId)) return;
  const result = classifyLinks(message.content, mod);
  if (result.action === "none" || result.action === "allow") return;
  if (result.action === "review" && hasAuthorizedLinkRole(message.member, mod)) return;

  const deleted = await deleteMessageImmediately(message, mod.deleteMessage);
  await reportViolation({
    client, message, guild: message.guild, moduleKey: "Anti-Link", moduleConfig: mod,
    infraction: result.reason || "Link não autorizado",
    action: deleted ? "Mensagem removida" : mod.deleteMessage ? "Remoção não concluída (verifique Manage Messages)" : "Exclusão desativada",
    staffAlert: Boolean(mod.staffChannelId)
  });
}

async function handleAntiSpam(client, message, config) {
  const mod = config.antiSpam;
  if (!mod.enabled || !isWatched(mod, message.channelId)) return;
  const key = `spam:${message.guildId}:${message.channelId}:${message.author.id}`;
  const signature = getMessageSignature(message);
  const list = remember(key, { signature }, Math.max(1000, mod.repeatWindowSeconds * 1000));
  const repeated = list.filter(item => item.signature === signature).length;
  const emojiTotal = countEmoji(message.content);
  const emojiOnlyText = String(message.content || "")
    .replace(/<a?:[a-zA-Z0-9_]{2,32}:\d{17,20}>/g, "")
    .replace(/[\p{Extended_Pictographic}\s]/gu, "");
  const emojiOnly = emojiTotal >= Number(mod.emojiLimit || 8) && normalizeText(emojiOnlyText) === "";
  if (repeated < Number(mod.repeats || 3) && !emojiOnly) return;
  histories.set(key, []);
  const cleanup = scheduleMemberWindowCleanup(client, message, "Anti-Spam", mod, mod.repeatWindowSeconds, mod.deleteMessage);
  const muteResult = await applySpamTimeout(message, mod.muteDurationSeconds, "Anti-Spam");
  const cleanupText = cleanup.scheduled
    ? `limpeza de todas as mensagens do membro na janela de ${cleanup.windowSeconds}s agendada para ${cleanup.delaySeconds}s`
    : cleanup.reason === "atraso 0" ? "mensagens mantidas (atraso de exclusão 0)" : "exclusão desativada";
  await reportViolation({
    client, message, guild: message.guild, moduleKey: "Anti-Spam", moduleConfig: mod,
    infraction: emojiOnly ? `Spam de emojis (${emojiTotal})` : `Mensagem repetida (${repeated} ocorrências)`,
    action: `${describeTimeoutResult(muteResult, mod.muteDurationSeconds)}; ${cleanupText}`,
    staffAlert: Boolean(mod.staffChannelId)
  });
}

async function handleAntiFlood(client, message, config) {
  const mod = config.antiFlood;
  if (!mod.enabled || !isWatched(mod, message.channelId)) return;
  const key = `flood:${message.guildId}:${message.channelId}:${message.author.id}`;
  const list = remember(key, {}, Math.max(1000, mod.windowSeconds * 1000));
  if (list.length < Number(mod.messageLimit || 7)) return;
  // Evita alertar em todas as mensagens do mesmo pico.
  histories.set(key, []);
  const cleanup = scheduleMemberWindowCleanup(client, message, "Anti-Flood", mod, mod.windowSeconds, mod.deleteTriggerMessage);
  const muteResult = await applySpamTimeout(message, mod.muteDurationSeconds, "Anti-Flood");
  const cleanupText = cleanup.scheduled
    ? `limpeza de todas as mensagens do membro na janela de ${cleanup.windowSeconds}s agendada para ${cleanup.delaySeconds}s`
    : cleanup.reason === "atraso 0" ? "mensagens mantidas (atraso de exclusão 0)" : "exclusão desativada";
  await reportViolation({
    client, message, guild: message.guild, moduleKey: "Anti-Flood", moduleConfig: mod,
    infraction: `${list.length} mensagens em ${mod.windowSeconds} segundos`,
    action: `${describeTimeoutResult(muteResult, mod.muteDurationSeconds)}; ${cleanupText}`,
    staffAlert: Boolean(mod.staffChannelId)
  });
}

async function handleMentionSpam(client, message, config) {
  const mod = config.mentionSpam;
  if (!mod.enabled || !isWatched(mod, message.channelId)) return;
  const total = countMentions(message);
  const key = `mentions:${message.guildId}:${message.channelId}:${message.author.id}`;
  const list = remember(key, { mentionCount: total }, Math.max(1000, Number(mod.windowSeconds || 10) * 1000));
  const mentionsInWindow = list.reduce((sum, item) => sum + Number(item.mentionCount || 0), 0);
  if (mentionsInWindow <= Number(mod.mentionLimit || 5)) return;
  histories.set(key, []);
  const cleanup = scheduleMemberWindowCleanup(client, message, "Spam de Menções", mod, mod.windowSeconds, mod.deleteMessage);
  const muteResult = await applySpamTimeout(message, mod.muteDurationSeconds, "Spam de Menções");
  const cleanupText = cleanup.scheduled
    ? `limpeza de todas as mensagens do membro na janela de ${cleanup.windowSeconds}s agendada para ${cleanup.delaySeconds}s`
    : cleanup.reason === "atraso 0" ? "mensagens mantidas (atraso de exclusão 0)" : "exclusão desativada";
  await reportViolation({
    client, message, guild: message.guild, moduleKey: "Spam de Menções", moduleConfig: mod,
    infraction: `${mentionsInWindow} menções em ${mod.windowSeconds} segundos`,
    action: `${describeTimeoutResult(muteResult, mod.muteDurationSeconds)}; ${cleanupText}`,
    staffAlert: Boolean(mod.staffChannelId)
  });
}

export async function handleMessageCreate(client, message) {
  if (!message.guild || message.guild.id !== process.env.POOL_PARTY_GUILD_ID || message.author?.bot || message.webhookId) return;
  try {
    const handled = await handleModerationCommand(client, message);
    if (handled) return;
    const config = getGuildConfig(message.guildId);
    // Cada módulo é avaliado separadamente e usa sua própria lista de canais.
    await handleAutoMod(client, message, config);
    await handleAntiLink(client, message, config);
    await handleAntiSpam(client, message, config);
    await handleAntiFlood(client, message, config);
    await handleMentionSpam(client, message, config);
  } catch (error) {
    console.error(`[Futaba] Erro no processamento de mensagem: ${error.stack || error.message}`);
  }
}

export async function updateModuleConfig(guildId, moduleKey, patch) {
  const config = getGuildConfig(guildId);
  if (!config[moduleKey]) throw new Error("Módulo inválido.");
  Object.assign(config[moduleKey], patch);
  await saveGuildConfig(guildId, config);
  return config[moduleKey];
}
