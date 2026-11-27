import { EmbedBuilder } from "discord.js";
import { clip, renderTemplate, safeHttpsUrl } from "./security-utils.js";
import { scheduleMessageDeletion } from "./message-cleanup.js";

const COLORS = {
  success: 0x25C99A,
  warning: 0xE0A43B,
  danger: 0xD94A62,
  neutral: 0x5865F2
};

function configuredColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(value || "") ? Number.parseInt(value.slice(1), 16) : fallback;
}

function applyEmbedMedia(embed, imageUrl, thumbnailUrl, bannerUrl) {
  const image = safeHttpsUrl(imageUrl);
  const thumbnail = safeHttpsUrl(thumbnailUrl || bannerUrl);
  if (image) embed.setImage(image);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return embed;
}

function applyEmbedIdentity(embed, config, prefix, values) {
  const author = renderTemplate(config[`${prefix}Author`] || "", values).trim();
  const authorIcon = safeHttpsUrl(config[`${prefix}AuthorIconUrl`]);
  const footer = renderTemplate(config[`${prefix}Footer`] || "", values).trim();
  const footerIcon = safeHttpsUrl(config[`${prefix}FooterIconUrl`]);
  if (author) embed.setAuthor({ name: clip(author, 256), ...(authorIcon ? { iconURL: authorIcon } : {}) });
  if (footer) embed.setFooter({ text: clip(footer, 2048), ...(footerIcon ? { iconURL: footerIcon } : {}) });
  if (config[`${prefix}Timestamp`] !== false) embed.setTimestamp();
}

function addConfiguredFields(embed, config, prefix, values) {
  const raw = Array.isArray(config[`${prefix}Fields`]) ? config[`${prefix}Fields`] : [];
  for (const line of raw) {
    if (embed.data.fields.length >= 25) break;
    const parts = String(line).split("|");
    const name = renderTemplate(parts.shift() || "Campo", values).trim();
    const value = renderTemplate(parts.shift() || "—", values).trim();
    const inline = String(parts.shift() || "false").trim().toLowerCase() === "true";
    if (!name || !value) continue;
    embed.addFields({ name: clip(name, 256), value: clip(value, 1024), inline });
  }
}

async function fetchTextChannel(client, channelId) {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased?.() && channel.messages ? channel : null;
}

export async function sendPublicNotice(client, message, moduleConfig, template, values = {}, color = "warning") {
  const channel = await fetchTextChannel(client, moduleConfig.publicChannelId) || message?.channel;
  if (!channel?.isTextBased?.()) return false;
  const content = renderTemplate(template || "<@{user}> uma regra do servidor foi acionada.", {
    user: message?.author?.id || values.user || "",
    channel: message?.channel?.name || values.channel || "canal",
    ...values
  });
  const targetUserId = message?.author?.id || values.user || null;
  const requiredMention = targetUserId ? `<@${targetUserId}>` : "";
  const finalContent = requiredMention && !content.includes(requiredMention)
    ? `${requiredMention} ${content}`
    : content;
  const payload = {
    content: finalContent.slice(0, 1900),
    allowedMentions: targetUserId
      ? { parse: [], users: [targetUserId], roles: [] }
      : { parse: [] }
  };
  const banner = safeHttpsUrl(moduleConfig.bannerUrl);
  if (banner) {
    payload.embeds = [new EmbedBuilder().setColor(COLORS[color] || COLORS.warning).setImage(banner)];
  }
  try {
    const sentMessage = await channel.send(payload);
    const cleanup = scheduleMessageDeletion(sentMessage, moduleConfig.noticeDeleteDelaySeconds, "aviso público");
    if (cleanup.scheduled) {
      console.info(`[Futaba] Aviso público será excluído em ${cleanup.delaySeconds}s.`);
    }
    return true;
  } catch (error) {
    console.error(`[Futaba] Não foi possível enviar aviso público: ${error.message}`);
    return false;
  }
}

export async function sendMemberDM(member, template, values = {}) {
  if (!member?.send) return false;
  const content = renderTemplate(template || "Uma regra do servidor foi acionada.", values);
  try {
    await member.send({ content: content.slice(0, 1900), allowedMentions: { parse: [] } });
    return true;
  } catch {
    return false;
  }
}

export async function sendModuleLog(client, guild, moduleKey, title, details = {}, moduleConfig = {}) {
  const channel = await fetchTextChannel(client, moduleConfig.logChannelId);
  if (!channel) return false;
  const embed = new EmbedBuilder()
    .setColor(configuredColor(moduleConfig.logEmbedColor, COLORS.neutral))
    .setTitle(clip(renderTemplate(moduleConfig.logEmbedTitle || `Registro • {type}`, { type: title, module: moduleKey, server: guild.name }), 256))
    .setDescription(clip(renderTemplate(moduleConfig.logEmbedDescription || "**Módulo:** {module}\n**Servidor:** {server}", { type: title, module: moduleKey, server: guild.name }), 4000));
  const templateValues = { type: title, module: moduleKey, server: guild.name };
  applyEmbedIdentity(embed, moduleConfig, "logEmbed", templateValues);
  applyEmbedMedia(embed, moduleConfig.logEmbedImageUrl, moduleConfig.logEmbedThumbnailUrl, moduleConfig.bannerUrl);
  const fields = [
    ["Membro", details.user ? `${details.user} (${details.userId || "ID indisponível"})` : null],
    ["ID do membro", details.userId],
    ["Canal", details.channel],
    ["Conteúdo", details.content],
    ["Infração", details.infraction],
    ["Ação", details.action],
    ["Responsável", details.actor],
    ["Detalhes", details.extra]
  ];
  if (moduleConfig.logEmbedIncludeDefaultFields !== false) {
    for (const [name, value] of fields) {
      if (value) embed.addFields({ name, value: clip(value, 900) });
    }
  }
  addConfiguredFields(embed, moduleConfig, "logEmbed", { ...templateValues, ...details });
  const mappedKeys = new Set(["user", "userId", "channel", "content", "infraction", "action", "actor", "extra"]);
  for (const [name, value] of Object.entries(details)) {
    if (mappedKeys.has(name) || value === undefined || value === null || String(value).length === 0) continue;
    if (embed.data.fields.length >= 25) break;
    embed.addFields({ name: clip(name, 256), value: clip(value, 900) });
  }
  try {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    console.error(`[Futaba] Falha ao gravar log: ${error.message}`);
    return false;
  }
}

export async function sendStaffAlert(client, guild, moduleKey, title, details = {}, moduleConfig = {}) {
  const channel = await fetchTextChannel(client, moduleConfig.staffChannelId);
  if (!channel) {
    if (moduleConfig.staffChannelId) {
      console.error(`[Futaba] Canal de alerta da equipe (${moduleConfig.staffChannelId}) não encontrado ou não acessível para ${moduleKey}.`);
    }
    return false;
  }
  const roleIds = [...new Set(moduleConfig.staffRoleIds || [])].filter(id => guild.roles.cache.has(id));
  const mentions = roleIds.map(id => `<@&${id}>`).join(" ");
  const embed = new EmbedBuilder()
    .setColor(configuredColor(moduleConfig.staffEmbedColor, COLORS.danger))
    .setTitle(clip(renderTemplate(moduleConfig.staffEmbedTitle || `Alerta de moderação • {type}`, { type: title, module: moduleKey, server: guild.name }), 256))
    .setDescription(clip(renderTemplate(moduleConfig.staffEmbedDescription || "**Módulo:** {module}\n**Servidor:** {server}", { type: title, module: moduleKey, server: guild.name }), 4000));
  const templateValues = { type: title, module: moduleKey, server: guild.name };
  applyEmbedIdentity(embed, moduleConfig, "staffEmbed", templateValues);
  applyEmbedMedia(embed, moduleConfig.staffEmbedImageUrl, moduleConfig.staffEmbedThumbnailUrl, moduleConfig.bannerUrl);
  const fields = [
    ["Membro", details.user ? `${details.user} (${details.userId || "ID indisponível"})` : null],
    ["ID do membro", details.userId],
    ["Canal", details.channel],
    ["Conteúdo detectado", details.content],
    ["Tipo de infração", details.infraction],
    ["Ação realizada", details.action],
    ["Executor identificado", details.actor],
    ["Detalhes técnicos", details.extra]
  ];
  if (moduleConfig.staffEmbedIncludeDefaultFields !== false) {
    for (const [name, value] of fields) {
      if (value) embed.addFields({ name, value: clip(value, 900) });
    }
  }
  addConfiguredFields(embed, moduleConfig, "staffEmbed", { ...templateValues, ...details });
  const mappedKeys = new Set(["user", "userId", "channel", "content", "infraction", "action", "actor", "extra"]);
  for (const [name, value] of Object.entries(details)) {
    if (mappedKeys.has(name) || value === undefined || value === null || String(value).length === 0) continue;
    if (embed.data.fields.length >= 25) break;
    embed.addFields({ name: clip(name, 256), value: clip(value, 900) });
  }
  try {
    await channel.send({
      content: mentions || undefined,
      embeds: [embed],
      allowedMentions: { parse: [], users: [], roles: roleIds }
    });
    return true;
  } catch (error) {
    console.error(`[Futaba] Falha ao enviar alerta à equipe: ${error.message}`);
    return false;
  }
}

export async function reportViolation({ client, message, guild, moduleKey, moduleConfig, infraction, action, staffAlert = false, publicNotice = true, dm = true }) {
  const details = {
    user: `${message.author.tag}`,
    userId: message.author.id,
    channel: `#${message.channel.name} (${message.channel.id})`,
    content: clip(message.content || "[anexo/sticker sem texto]", 900),
    infraction,
    action
  };
  if (publicNotice) {
    await sendPublicNotice(client, message, moduleConfig, moduleConfig.publicMessage, {
      user: message.author.id,
      channel: message.channel.name,
      type: infraction,
      action,
      content: clip(message.content, 300)
    }, "warning");
  }
  if (dm) {
    await sendMemberDM(message.member, moduleConfig.dmMessage, {
      user: message.author.id,
      channel: message.channel.name,
      type: infraction,
      action,
      content: clip(message.content, 300)
    });
  }
  await sendModuleLog(client, guild, moduleKey, infraction, details, moduleConfig);
  if (staffAlert) {
    const sent = await sendStaffAlert(client, guild, moduleKey, infraction, details, moduleConfig);
    if (!sent && moduleConfig.staffChannelId) {
      console.error(`[Futaba] O alerta de ${moduleKey} não foi entregue. Verifique View Channel, Send Messages e Embed Links no canal de alertas.`);
    }
  }
}
