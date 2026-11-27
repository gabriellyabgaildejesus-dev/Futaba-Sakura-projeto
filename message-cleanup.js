/**
 * Busca todas as mensagens recentes de um membro em um canal dentro de uma janela.
 * A paginação continua até alcançar mensagens anteriores ao início da janela.
 */
export async function fetchMemberMessagesInWindow(triggerMessage, windowSeconds) {
  const channel = triggerMessage?.channel;
  const authorId = triggerMessage?.author?.id;
  const endMs = Number(triggerMessage?.createdTimestamp || Date.now());
  const durationMs = Math.max(1, Number(windowSeconds) || 1) * 1000;
  const startMs = endMs - durationMs;

  if (!channel?.messages?.fetch || !authorId) {
    throw new Error("Não foi possível acessar o histórico deste canal ou identificar o membro.");
  }

  const botMember = channel.guild?.members?.me;
  const permissions = botMember?.permissionsIn?.(channel);
  if (permissions?.has) {
    if (!permissions.has("ReadMessageHistory")) {
      throw new Error("A Futaba precisa da permissão Ler histórico de mensagens neste canal.");
    }
    if (!permissions.has("ManageMessages")) {
      throw new Error("A Futaba precisa da permissão Gerenciar mensagens neste canal.");
    }
  }

  const matches = new Map();
  if (triggerMessage.id && endMs >= startMs) matches.set(triggerMessage.id, triggerMessage);

  let before;
  let previousCursor;
  while (true) {
    const options = { limit: 100 };
    if (before) options.before = before;
    const batch = await channel.messages.fetch(options);
    const page = [...batch.values()];
    if (page.length === 0) break;

    let oldestMessage = null;
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (const item of page) {
      const createdAt = Number(item.createdTimestamp || 0);
      if (createdAt < oldestTimestamp) {
        oldestTimestamp = createdAt;
        oldestMessage = item;
      }
      if (
        item.author?.id === authorId &&
        createdAt >= startMs &&
        createdAt <= endMs
      ) {
        matches.set(item.id, item);
      }
    }

    // A página já foi examinada; se a mensagem mais antiga passou do início,
    // todas as páginas seguintes também estarão fora do intervalo.
    if (oldestTimestamp < startMs) break;
    if (!oldestMessage?.id || oldestMessage.id === previousCursor) break;
    if (page.length < 100) break;

    previousCursor = before;
    before = oldestMessage.id;
    if (before === previousCursor) break;
  }

  return [...matches.values()].filter(item => item?.id).sort(
    (a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0)
  );
}

/** Exclui mensagens recentes em lotes de até 100, com fallback individual. */
export async function deleteFetchedMessages(channel, messages) {
  const unique = [...new Map(messages.filter(item => item?.id).map(item => [item.id, item])).values()];
  const deletedIds = new Set();
  const failedIds = new Set();

  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);

    if (batch.length >= 2 && typeof channel?.bulkDelete === "function") {
      try {
        const result = await channel.bulkDelete(batch.map(item => item.id), true);
        const ids = Array.isArray(result)
          ? result
          : result && typeof result.keys === "function"
            ? [...result.keys()]
            : [];
        for (const id of ids) deletedIds.add(id);

        // Se a API não confirmar algum ID, tenta excluir apenas aquela mensagem.
        const confirmed = new Set(ids);
        for (const item of batch) {
          if (confirmed.has(item.id)) continue;
          try {
            await item.delete();
            deletedIds.add(item.id);
          } catch {
            failedIds.add(item.id);
          }
        }
        continue;
      } catch (error) {
        console.warn(`[Futaba] Exclusão em lote falhou; tentando mensagens individualmente: ${error.message}`);
      }
    }

    for (const item of batch) {
      try {
        await item.delete();
        deletedIds.add(item.id);
      } catch {
        failedIds.add(item.id);
      }
    }
  }

  return { deletedCount: deletedIds.size, failedCount: failedIds.size };
}

export async function purgeMemberMessagesInWindow(triggerMessage, windowSeconds) {
  const messages = await fetchMemberMessagesInWindow(triggerMessage, windowSeconds);
  const result = await deleteFetchedMessages(triggerMessage.channel, messages);
  return { matchedCount: messages.length, ...result };
}


/** Agenda a exclusão de uma mensagem do próprio bot após o atraso configurado. */
export function scheduleMessageDeletion(message, delaySeconds, label = "mensagem", scheduleTimeout = setTimeout) {
  const seconds = Number(delaySeconds);
  if (!message?.delete || !Number.isFinite(seconds) || seconds <= 0) {
    return { scheduled: false, reason: seconds === 0 ? "atraso 0" : "atraso não configurado" };
  }

  const timer = scheduleTimeout(async () => {
    try {
      await message.delete();
    } catch (error) {
      // A mensagem pode já ter sido removida manualmente ou pela moderação.
      console.warn(`[Futaba] Não foi possível excluir ${label}: ${error.message}`);
    }
  }, Math.min(seconds, 3600) * 1000);
  timer.unref?.();
  return { scheduled: true, delaySeconds: Math.min(seconds, 3600) };
}
