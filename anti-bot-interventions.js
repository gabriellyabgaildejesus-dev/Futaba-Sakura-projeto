/**
 * Detecta alterações feitas por terceiros em bots ainda protegidos pelo Anti-Bot.
 * A função é pura para que as regras possam ser testadas sem conexão com o Discord.
 */
export function isTrustedAntiBot(antiBot, botId) {
  return Boolean(botId && (antiBot?.trustedBotIds || []).includes(botId));
}

function protectedBotId(id, antiBot) {
  if (!id) return false;
  return Boolean(antiBot?.pending?.[id] || (antiBot?.blockedBotIds || []).includes(id));
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function timeoutWasRemovedOrShortened(entry) {
  const change = (entry.changes || []).find(item => item.key === "communication_disabled_until");
  if (!change || change.old === undefined || change.old === null || change.old === "") return false;

  const oldUntil = parseTimestamp(change.old);
  if (oldUntil === null) return false;
  const eventTime = Number(entry.createdTimestamp) || Date.now();
  if (oldUntil <= eventTime) return false;

  // Null/vazio remove o timeout. Uma nova data anterior também o encurta.
  if (change.new === undefined || change.new === null || change.new === "") return true;
  const newUntil = parseTimestamp(change.new);
  return newUntil !== null && newUntil < oldUntil;
}

function toPermissionBits(value) {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
}

function permissionsWereExpanded(entry) {
  const change = (entry.changes || []).find(item => item.key === "permissions");
  if (!change) return false;
  const before = toPermissionBits(change.old);
  const after = toPermissionBits(change.new);
  return (after & ~before) !== 0n;
}

function overwriteGrantedAccess(entry, action, eventTypes) {
  const changes = entry.changes || [];
  const allow = changes.find(item => item.key === "allow");
  const deny = changes.find(item => item.key === "deny");

  if (action === eventTypes.ChannelOverwriteCreate) {
    return Boolean(allow && toPermissionBits(allow.new) !== 0n);
  }
  if (action === eventTypes.ChannelOverwriteUpdate) {
    const addedAllow = allow && (toPermissionBits(allow.new) & ~toPermissionBits(allow.old)) !== 0n;
    const removedDeny = deny && (toPermissionBits(deny.old) & ~toPermissionBits(deny.new)) !== 0n;
    return Boolean(addedAllow || removedDeny);
  }
  if (action === eventTypes.ChannelOverwriteDelete) {
    // Excluir um overwrite que negava permissões pode reabrir o canal ao bot.
    return Boolean(deny && toPermissionBits(deny.old) !== 0n);
  }
  return false;
}

/**
 * @param {object} entry Discord audit log entry
 * @param {object} antiBot Anti-Bot settings
 * @param {object} eventTypes AuditLogEvent enum from discord.js
 * @returns {{botId: string, kind: string}|null}
 */
export function detectProtectedBotIntervention(entry, antiBot, eventTypes) {
  if (!entry || !antiBot || !eventTypes) return null;
  const targetId = entry.targetId || null;
  const pending = antiBot.pending || {};
  const protectedTarget = protectedBotId(targetId, antiBot);

  if (entry.action === eventTypes.MemberUpdate) {
    if (protectedTarget && timeoutWasRemovedOrShortened(entry)) {
      return { botId: targetId, kind: "remoção ou redução do timeout (mute)" };
    }
    return null;
  }

  if (entry.action === eventTypes.MemberRoleUpdate && protectedTarget) {
    return { botId: targetId, kind: "alteração de cargos do bot em quarentena" };
  }

  if (entry.action === eventTypes.MemberBanRemove && protectedTarget) {
    return { botId: targetId, kind: "tentativa de desbanimento do bot protegido" };
  }

  const possibleTargets = [targetId, entry.extra?.id, entry.extra?.userId, entry.extra?.user?.id].filter(Boolean);
  const roleTargetEntry = Object.entries(pending).find(([, item]) =>
    item.quarantineRoleId && possibleTargets.includes(item.quarantineRoleId)
  );

  if (roleTargetEntry && entry.action === eventTypes.RoleUpdate && permissionsWereExpanded(entry)) {
    return { botId: roleTargetEntry[0], kind: "restauração de permissões no cargo de quarentena" };
  }

  const overwriteActions = [
    eventTypes.ChannelOverwriteCreate,
    eventTypes.ChannelOverwriteUpdate,
    eventTypes.ChannelOverwriteDelete
  ];
  if (overwriteActions.includes(entry.action) && overwriteGrantedAccess(entry, entry.action, eventTypes)) {
    const botTarget = possibleTargets.find(id => protectedBotId(id, antiBot));
    if (botTarget) {
      return { botId: botTarget, kind: "restauração de permissões de canal diretamente ao bot" };
    }
    if (roleTargetEntry) {
      return { botId: roleTargetEntry[0], kind: "restauração de acesso pelo cargo de quarentena" };
    }
  }

  return null;
}
