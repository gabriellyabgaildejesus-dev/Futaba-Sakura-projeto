const MAX_TIMEOUT_SECONDS = 2_419_200; // Limite do Discord: 28 dias.
const appliedTimeouts = new Map();

/**
 * Aplica o timeout usando exatamente a duração configurada no módulo.
 * Tenta buscar o membro caso message.member não esteja disponível no evento.
 * Retorna o motivo explícito quando o Discord não permite a punição.
 */
export async function applyConfiguredTimeout(message, durationSeconds, moduleName = "moderação automática") {
  const seconds = Number(durationSeconds);

  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_TIMEOUT_SECONDS) {
    return { applied: false, skipped: false, reason: "duração inválida; o limite do Discord é de 0 a 2.419.200 segundos" };
  }
  if (seconds === 0) {
    return { applied: false, skipped: true, reason: "mute desativado na configuração (0 segundos)" };
  }

  const guild = message?.guild;
  let member = message?.member || null;

  if ((!member || typeof member.timeout !== "function") && guild?.members?.fetch && message?.author?.id) {
    try {
      member = await guild.members.fetch(message.author.id);
    } catch (error) {
      return { applied: false, skipped: false, reason: `não foi possível buscar o membro no servidor: ${error.message}` };
    }
  }

  if (!member || typeof member.timeout !== "function") {
    return { applied: false, skipped: false, reason: "objeto do membro indisponível para aplicar timeout" };
  }

  const botMember = guild?.members?.me;
  if (botMember?.permissions?.has && !botMember.permissions.has("ModerateMembers")) {
    return { applied: false, skipped: false, reason: "a Futaba não possui a permissão Moderar membros" };
  }

  if (member.id && guild?.ownerId && member.id === guild.ownerId) {
    return { applied: false, skipped: false, reason: "o proprietário do servidor não pode receber timeout" };
  }

  if (member.moderatable === false) {
    return { applied: false, skipped: false, reason: "membro não moderável pela hierarquia de cargos ou pelas permissões atuais da Futaba" };
  }

  const now = Date.now();
  const timeoutKey = `${guild?.id || message.guildId || "guild"}:${member.id || message.author.id}`;
  for (const [key, expiresAt] of appliedTimeouts) {
    if (expiresAt <= now) appliedTimeouts.delete(key);
  }
  const discordExpiry = Number(member.communicationDisabledUntilTimestamp || 0);
  const trackedExpiry = Number(appliedTimeouts.get(timeoutKey) || 0);
  const currentExpiry = Math.max(discordExpiry, trackedExpiry);
  const requestedExpiry = now + seconds * 1000;
  if (currentExpiry > requestedExpiry) {
    return {
      applied: false,
      skipped: true,
      alreadyActive: true,
      endsAt: new Date(currentExpiry).toISOString(),
      reason: "um timeout mais longo já está ativo e foi preservado"
    };
  }

  try {
    await member.timeout(seconds * 1000, `Futaba Sakura: ${moduleName}`);
    const endsAt = Date.now() + seconds * 1000;
    appliedTimeouts.set(timeoutKey, endsAt);
    return {
      applied: true,
      skipped: false,
      durationSeconds: seconds,
      endsAt: new Date(endsAt).toISOString()
    };
  } catch (error) {
    const code = error?.code ? ` (código ${error.code})` : "";
    return { applied: false, skipped: false, reason: `${error.message || "erro desconhecido ao aplicar timeout"}${code}` };
  }
}

export function describeTimeoutResult(result, configuredSeconds) {
  if (result?.applied) return `Timeout de ${result.durationSeconds}s aplicado`;
  if (result?.alreadyActive) return `Timeout menor não aplicado: punição mais longa preservada até ${result.endsAt}`;
  if (result?.skipped) return "Timeout desativado (0s configurado)";
  return `Timeout NÃO aplicado: ${result?.reason || `falha desconhecida; configuração solicitava ${configuredSeconds}s`}`;
}
