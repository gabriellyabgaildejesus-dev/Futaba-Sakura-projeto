export function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function getMessageSignature(message) {
  const content = normalizeText(message.content || "");
  const stickers = message.stickers?.map(item => item.id).sort().join(",") || "";
  const attachments = [...(message.attachments?.values?.() || [])]
    .map(item => `${item.name || ""}:${item.size || 0}:${item.contentType || ""}`)
    .sort().join(",");
  return `${content}|stickers:${stickers}|attachments:${attachments}`;
}

export function isWatched(config, channelId) {
  return Array.isArray(config.watchChannelIds) && config.watchChannelIds.includes(channelId);
}

export function canManageFutaba(member, guildOwnerId = null) {
  const userId = member?.id || member?.user?.id || null;
  if (guildOwnerId && userId === guildOwnerId) return true;
  if (member?.guild?.ownerId && userId === member.guild.ownerId) return true;
  const permissions = member?.permissions;
  if (permissions && typeof permissions.has === "function") {
    return permissions.has(8n);
  }
  try {
    const bits = BigInt(String(permissions || "0"));
    return (bits & 8n) === 8n;
  } catch {
    return false;
  }
}

export function renderTemplate(template, values = {}) {
  let result = String(template || "");
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, String(value ?? ""));
  }
  return result;
}

export function safeHttpsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function clip(value, max = 900) {
  const clean = String(value || "[sem conteúdo]").replace(/@everyone/g, "@ everyone").replace(/@here/g, "@ here");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Normalize AutoMod text while treating emoji as separators, never as words. */
export function normalizeAutoModText(value = "") {
  return String(value)
    // Remove Discord custom emoji markup before processing Unicode emoji.
    .replace(/<a?:[a-zA-Z0-9_]{2,32}:\d{17,20}>/g, " ")
    // Replace pictographs with spaces so adjacent words do not get joined.
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)*/gu, " ")
    .replace(/[\uFE0E\uFE0F\u200D]/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
