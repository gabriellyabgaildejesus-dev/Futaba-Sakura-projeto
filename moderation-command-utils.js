const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const MAX_CLEAR = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseMemberId(value = "") {
  const mention = String(value).match(/^<@!?(\d{17,20})>$/);
  if (mention) return mention[1];
  return /^\d{17,20}$/.test(String(value)) ? String(value) : null;
}

export function parseDuration(value = "") {
  const match = String(value).trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2].toLowerCase()];
  const seconds = n * unit;
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds * 1000 <= MAX_TIMEOUT_MS ? seconds : null;
}

async function fetchRecent(channel, beforeId, max = MAX_CLEAR) {
  const collected = [];
  let cursor = beforeId || null;
  while (collected.length < max) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, max - collected.length), ...(cursor ? { before: cursor } : {}) });
    if (!batch.size) break;
    const values = [...batch.values()];
    collected.push(...values);
    cursor = values[values.length - 1]?.id;
    if (batch.size < 100) break;
  }
  return collected;
}

export async function clearMessages(channel, requestedCount, targetId = null, now = Date.now()) {
  const recent = await fetchRecent(channel, null, targetId ? MAX_CLEAR : requestedCount);
  const selected = recent.filter(item => !targetId || item.author?.id === targetId).slice(0, requestedCount);
  const young = selected.filter(item => now - item.createdTimestamp < 14 * DAY_MS);
  const old = selected.filter(item => now - item.createdTimestamp >= 14 * DAY_MS);
  let deleted = 0;
  let failed = 0;
  for (let index = 0; index < young.length; index += 100) {
    const batch = young.slice(index, index + 100);
    if (batch.length === 1) {
      try { await batch[0].delete(); deleted += 1; }
      catch { failed += 1; }
      continue;
    }
    try {
      const result = await channel.bulkDelete(batch, true);
      deleted += result.size;
    } catch { failed += batch.length; }
  }
  for (const item of old) {
    try { await item.delete(); deleted += 1; }
    catch { failed += 1; }
  }
  return { requested: requestedCount, matched: selected.length, deleted, failed, targetId };
}
