import { getGuildConfig } from "./store.js";
import { getAppealsGuild, persistAppealsStore, createAppealId } from "./appeals-store.js";

const FINAL_STATES = new Set(["accepted", "rejected", "closed"]);
const ACTIVE_STATES = new Set(["pending", "in_analysis", "waiting_member", "waiting_staff"]);
const STATUS_LABELS = {
  pending: "Pendente", in_analysis: "Em análise", waiting_member: "Aguardando membro",
  waiting_staff: "Aguardando staff", accepted: "Aceita", rejected: "Rejeitada", closed: "Encerrada"
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ID_RE = /^\d{17,20}$/;
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_MESSAGE_LENGTH = 4000;

function cleanText(value, max = 4000) {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}
function safeHttps(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost") return null;
    if (/^(127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}
function validateAttachments(value, maxCount = 8, maxTotal = 3 * 1024 * 1024) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxCount) throw Object.assign(new Error(`Envie no máximo ${maxCount} imagens.`), { status: 400 });
  let total = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw Object.assign(new Error(`Anexo ${index + 1} inválido.`), { status: 400 });
    const name = cleanText(item.name, 120) || `evidencia-${index + 1}`;
    const mimeType = String(item.mimeType || "").toLowerCase();
    const data = String(item.data || "");
    if (!IMAGE_MIME.has(mimeType) || !data.startsWith(`data:${mimeType};base64,`)) throw Object.assign(new Error(`O arquivo ${name} não é uma imagem permitida.`), { status: 400 });
    const encoded = data.slice(data.indexOf(",") + 1);
    if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw Object.assign(new Error(`O arquivo ${name} está inválido.`), { status: 400 });
    const buffer = Buffer.from(encoded, "base64");
    if (!buffer.length || buffer.length > 600 * 1024) throw Object.assign(new Error(`Cada imagem deve ter até 600 KB.`), { status: 413 });
    total += buffer.length;
    if (total > maxTotal) throw Object.assign(new Error(`O total dos anexos excede ${Math.round(maxTotal / 1024)} KB.`), { status: 413 });
    const validMagic = mimeType === "image/png" ? buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : mimeType === "image/jpeg" ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : mimeType === "image/gif" ? buffer.subarray(0, 3).toString() === "GIF"
      : mimeType === "image/webp" ? buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP" : false;
    if (!validMagic) throw Object.assign(new Error(`O conteúdo da imagem ${name} não corresponde ao formato informado.`), { status: 400 });
    return { id: `${index + 1}-${Date.now()}`, name, mimeType, size: buffer.length, data };
  });
}
function actorFrom(body) {
  const actor = body?.actor;
  if (!actor || !ID_RE.test(String(actor.id || ""))) throw Object.assign(new Error("Sessão de usuário inválida."), { status: 401 });
  return {
    id: String(actor.id), username: cleanText(actor.username, 64), globalName: cleanText(actor.globalName, 64),
    avatar: cleanText(actor.avatar, 256) || null
  };
}
function isAdmin(member, guild) {
  return Boolean(member && (member.id === guild.ownerId || member.permissions?.has?.(8n) || ((BigInt(member.permissions?.bitfield ?? 0n) & 8n) === 8n)));
}
function hasAnyRole(member, roleIds = []) {
  return Boolean(member && roleIds.some(roleId => member.roles?.cache?.has?.(roleId)));
}
async function fetchMember(guild, userId) {
  try { return await guild.members.fetch({ user: userId, force: true }); }
  catch { return null; }
}
async function checkBanned(guild, userId) {
  try { return Boolean(await guild.bans.fetch({ user: userId })); }
  catch { return false; }
}
function staffPermissions(member, guild, config) {
  const roles = config.appeals || {};
  const admin = isAdmin(member, guild);
  const canView = admin || hasAnyRole(member, roles.viewRoleIds) || hasAnyRole(member, roles.assumeRoleIds) || hasAnyRole(member, roles.decideRoleIds) || hasAnyRole(member, roles.manageRoleIds);
  return {
    isStaff: canView,
    canView,
    canAssume: admin || hasAnyRole(member, roles.assumeRoleIds),
    canDecide: admin || hasAnyRole(member, roles.decideRoleIds),
    canManage: admin || hasAnyRole(member, roles.manageRoleIds)
  };
}
async function eligibility(client, guild, userId) {
  if (!ID_RE.test(String(userId || ""))) throw Object.assign(new Error("ID Discord inválido."), { status: 400 });
  const member = await fetchMember(guild, userId);
  const isBanned = member ? false : await checkBanned(guild, userId);
  const config = getGuildConfig(guild.id);
  const permissions = staffPermissions(member, guild, config);
  const user = member ? {
    id: member.id,
    username: member.user.username,
    globalName: member.user.globalName || member.displayName || member.user.username,
    avatar: member.user.displayAvatarURL({ extension: "png", size: 128 })
  } : null;
  const active = getAppealConfig(guild.id).active !== false;
  return { isMember: Boolean(member), isBanned, active, canSubmit: Boolean(member || isBanned) && active, user, ...permissions };
}
function addAudit(appeal, actor, action, details = {}) {
  appeal.audit ||= [];
  appeal.audit.push({ actorId: actor?.id || null, actorName: actor?.globalName || actor?.username || "Sistema", action, details, at: new Date().toISOString() });
}
function publicMessage(message) {
  return { id: message.id, senderId: message.senderId, senderName: message.senderName, senderAvatar: message.senderAvatar, senderType: message.senderType, content: message.content, attachments: (message.attachments || []).map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, data: a.data })), at: message.at };
}
function summary(appeal) {
  return {
    id: appeal.id, ownerId: appeal.ownerId, memberName: appeal.memberName, memberAvatar: appeal.memberAvatar,
    reason: appeal.reason, status: appeal.status, statusLabel: STATUS_LABELS[appeal.status] || appeal.status,
    assignedTo: appeal.assignedTo, createdAt: appeal.createdAt, updatedAt: appeal.updatedAt,
    lastMessageAt: appeal.messages?.at(-1)?.at || appeal.updatedAt,
    decisionAt: appeal.decision?.at || null,
    unreadForStaff: Boolean(appeal.unreadForStaff), unreadForMember: Boolean(appeal.unreadForMember),
    email: appeal.reason === "ban" ? appeal.email : undefined
  };
}
function detail(appeal, includeInternal = false) {
  const result = structuredClone(appeal);
  result.messages = (appeal.messages || []).map(publicMessage);
  if (!includeInternal) {
    delete result.audit;
    delete result.internalNotes;
    delete result.email;
  }
  return result;
}
function ensureAppealAccess(appeal, userId, staff) {
  if (appeal.ownerId === userId) return "member";
  if (staff.canView) return "staff";
  throw Object.assign(new Error("Você não tem permissão para acessar esta apelação."), { status: 403 });
}
function validateReason(reason) {
  if (!new Set(["ban", "warn", "mute"]).has(reason)) throw Object.assign(new Error("Selecione um motivo válido."), { status: 400 });
}
function getAppealConfig(guildId) { return getGuildConfig(guildId).appeals || {}; }
function appealStore(guildId) { return getAppealsGuild(guildId); }

async function sendEmail(to, subject, text, html) {
  const apiKey = process.env.APPEALS_EMAIL_API_KEY || "";
  const from = process.env.APPEALS_EMAIL_FROM || "";
  if (!apiKey || !from) return { delivered: false, channel: "email", reason: "Envio de e-mail ainda não configurado no host do bot." };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text, html })
  });
  if (!response.ok) return { delivered: false, channel: "email", reason: `O serviço de e-mail respondeu ${response.status}.` };
  return { delivered: true, channel: "email" };
}
function htmlEscape(value) { return String(value || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
function siteUrl(path) {
  const base = (process.env.PUBLIC_SITE_URL || "https://futabasakura.netlify.app").replace(/\/$/, "");
  return `${base}${path}`;
}
async function notifyUser(client, guild, appeal, text) {
  const link = siteUrl(`/appeals.html?id=${encodeURIComponent(appeal.id)}`);
  if (appeal.reason === "ban" && appeal.email) {
    const safeText = `${text}\n\nAcesse sua Central de Apelações: ${link}`;
    return sendEmail(appeal.email, `Atualização da apelação ${appeal.id} — POOL PARTY`, safeText, `<p>${htmlEscape(text)}</p><p><a href="${link}">Acessar Central de Apelações</a></p>`);
  }
  try {
    const user = await client.users.fetch(appeal.ownerId);
    await user.send(`${text}\n\nAcesse sua Central de Apelações: ${link}`);
    return { delivered: true, channel: "discord_dm" };
  } catch {
    return { delivered: false, channel: "discord_dm", reason: "Não foi possível enviar DM. Verifique as configurações de privacidade do membro." };
  }
}
async function notifyStaffChannel(client, guild, appeal, text) {
  const channelId = getAppealConfig(guild.id).alertChannelId;
  if (!channelId) return { delivered: false, reason: "Canal de alertas da Central ainda não configurado." };
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased?.() || typeof channel.send !== "function") return { delivered: false, reason: "O canal configurado não está disponível para envio." };
  const link = siteUrl(`/appeals-staff.html?id=${encodeURIComponent(appeal.id)}`);
  await channel.send({ content: `**${text}**\nIdentificação: \`${appeal.id}\` • Motivo: **${appeal.reason.toUpperCase()}** • Membro: **${appeal.memberName}**\n${link}`, allowedMentions: { parse: [] } });
  return { delivered: true, channel: channelId };
}
async function alertContactFailure(client, guild, appeal, context, delivery) {
  const channel = delivery?.channel || "canal de contato";
  const reason = cleanText(delivery?.reason || "Falha de entrega não especificada.", 300);
  const staffAlert = await notifyStaffChannel(client, guild, appeal, `Falha ao contatar o membro (${channel}) durante ${context}. Motivo: ${reason}`).catch(error => ({ delivered: false, reason: error.message }));
  addAudit(appeal, null, "member_contact_failed", { context, delivery, staffAlert });
  await persistAppealsStore();
  return staffAlert;
}
function canOperate(permissions, capability) {
  if (!permissions[capability]) throw Object.assign(new Error("Você não possui permissão para esta ação na Central de Apelações."), { status: 403 });
}

export async function handleAppealsApi({ client, guild, request, response, url, sendJson, readJson }) {
  const prefix = `/api/v1/guilds/${guild.id}/appeals`;
  if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length).split("/").filter(Boolean);

  try {
    if (request.method === "GET" && path.length === 1 && path[0] === "eligibility") {
      const userId = url.searchParams.get("userId");
      const result = await eligibility(client, guild, userId);
      sendJson(response, 200, result); return true;
    }

    if (request.method === "GET" && path.length === 0) {
      const userId = url.searchParams.get("userId");
      if (!ID_RE.test(String(userId || ""))) throw Object.assign(new Error("Usuário inválido."), { status: 400 });
      const member = await fetchMember(guild, userId);
      const perms = staffPermissions(member, guild, getGuildConfig(guild.id));
      const view = url.searchParams.get("view") || "member";
      const store = appealStore(guild.id);
      let items;
      if (view === "staff") {
        canOperate(perms, "canView");
        const status = url.searchParams.get("status") || "";
        const q = cleanText(url.searchParams.get("q") || "", 80).toLowerCase();
        items = store.appeals.filter(item => (!status || item.status === status) && (!q || `${item.id} ${item.memberName} ${item.ownerId}`.toLowerCase().includes(q))).map(summary);
        items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      } else {
        items = store.appeals.filter(item => item.ownerId === userId).map(summary).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      }
      sendJson(response, 200, { appeals: items, permissions: perms }); return true;
    }

    if (request.method === "POST" && path.length === 0) {
      const body = await readJson(request, 6 * 1024 * 1024);
      const actor = actorFrom(body);
      if (body.action !== "create") throw Object.assign(new Error("Operação inválida."), { status: 400 });
      if (getAppealConfig(guild.id).active === false) throw Object.assign(new Error("A Central está temporariamente fechada para novas apelações. Solicitações já abertas continuam disponíveis."), { status: 503 });
      validateReason(body.reason);
      const state = await eligibility(client, guild, actor.id);
      if (!state.canSubmit || (body.reason === "ban" && !state.isBanned) || (body.reason !== "ban" && !state.isMember)) {
        throw Object.assign(new Error("O tipo de apelação não corresponde à situação atual da sua conta no POOL PARTY."), { status: 403 });
      }
      const reason = body.reason;
      const email = cleanText(body.email, 254).toLowerCase();
      if (reason === "ban" && !EMAIL_RE.test(email)) throw Object.assign(new Error("Informe um endereço de e-mail válido para acompanhar a apelação de banimento."), { status: 400 });
      if (reason !== "ban" && body.dmAllowed !== true) throw Object.assign(new Error("Confirme que as mensagens diretas do POOL PARTY estão habilitadas."), { status: 400 });
      const description = cleanText(body.description, 5000);
      if (description.length < 20) throw Object.assign(new Error("A descrição precisa ter pelo menos 20 caracteres."), { status: 400 });
      const links = Array.isArray(body.links) ? body.links.slice(0, 8).map(safeHttps).filter(Boolean) : [];
      if (Array.isArray(body.links) && links.length !== body.links.filter(Boolean).length) throw Object.assign(new Error("Um ou mais links não são HTTPS válidos."), { status: 400 });
      const config = getAppealConfig(guild.id);
      const attachments = validateAttachments(body.attachments || [], Math.min(8, config.maxAttachments ?? 8), config.maxTotalAttachmentBytes || 3 * 1024 * 1024);
      const store = appealStore(guild.id);
      const openCount = store.appeals.filter(item => item.ownerId === actor.id && ACTIVE_STATES.has(item.status)).length;
      if (openCount >= (config.maxActivePerMember || 3)) throw Object.assign(new Error("Você já possui o limite de apelações em andamento. Aguarde a conclusão de uma delas."), { status: 429 });
      const appeal = {
        id: createAppealId(), ownerId: actor.id, memberName: actor.globalName || actor.username,
        memberUsername: actor.username, memberAvatar: actor.avatar, reason, email: reason === "ban" ? email : null,
        dmAllowed: reason === "ban" ? false : true, description, links, attachments,
        status: "pending", assignedTo: null, assignedProfile: null, decision: null,
        messages: [], audit: [], internalNotes: [], unreadForStaff: true, unreadForMember: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      const openingText = cleanText(config.openingMessage, 1000);
      if (openingText) appeal.messages.push({ id: `${Date.now()}-system`, senderId: "system", senderName: "Futaba Sakura", senderAvatar: null, senderType: "system", content: openingText, attachments: [], at: appeal.createdAt });
      addAudit(appeal, actor, "appeal_created", { reason });
      store.appeals.push(appeal);
      await persistAppealsStore();
      const notification = await notifyStaffChannel(client, guild, appeal, "Nova apelação recebida").catch(error => ({ delivered: false, reason: error.message }));
      const contact = await notifyUser(client, guild, appeal, `Recebemos sua apelação ${appeal.id}. A alta staff continuará o atendimento pela Central de Apelações.`).catch(error => ({ delivered: false, reason: error.message }));
      appeal.audit.push({ actorId: null, actorName: "Futaba Sakura", action: "staff_notification", details: notification, at: new Date().toISOString() });
      appeal.audit.push({ actorId: null, actorName: "Futaba Sakura", action: "member_receipt_notification", details: contact, at: new Date().toISOString() });
      if (!contact.delivered) await alertContactFailure(client, guild, appeal, "confirmação de recebimento", contact);
      await persistAppealsStore();
      const message = notification.delivered
        ? "Prontinho! Sua apelação foi enviada com sucesso, a alta staff foi avisada, por favor, espere por uma resposta."
        : "Sua apelação foi registrada com sucesso, mas a notificação da alta staff não foi entregue. A equipe poderá encontrá-la na Central; tente novamente mais tarde se necessário.";
      sendJson(response, 201, { appeal: summary(appeal), notification, contact, message }); return true;
    }

    if (path.length >= 1 && path[0] === "profile") {
      const body = request.method === "PATCH" ? await readJson(request) : {};
      const actor = request.method === "PATCH" ? actorFrom(body) : { id: url.searchParams.get("userId") };
      if (!ID_RE.test(String(actor.id || ""))) throw Object.assign(new Error("Usuário inválido."), { status: 400 });
      const member = await fetchMember(guild, actor.id);
      const perms = staffPermissions(member, guild, getGuildConfig(guild.id));
      canOperate(perms, "canView");
      if (request.method === "GET") {
        const profile = appealStore(guild.id).profiles[actor.id] || {};
        sendJson(response, 200, { profile: { ...profile, userId: actor.id, displayName: profile.displayName || member.displayName || member.user.username, avatarUrl: profile.avatarUrl || member.user.displayAvatarURL({ extension: "png", size: 128 }) } }); return true;
      }
      if (request.method === "PATCH") {
        const displayName = cleanText(body.displayName, 40);
        const description = cleanText(body.description, 180);
        const color = /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color : "#ef1748";
        const avatarUrl = body.avatarUrl ? safeHttps(body.avatarUrl) : null;
        if (body.avatarUrl && !avatarUrl) throw Object.assign(new Error("O avatar personalizado precisa ser uma URL HTTPS válida."), { status: 400 });
        const store = appealStore(guild.id);
        store.profiles[actor.id] = { displayName: displayName || actor.globalName || actor.username, description, color, avatarUrl, updatedAt: new Date().toISOString() };
        await persistAppealsStore();
        sendJson(response, 200, { profile: { ...store.profiles[actor.id], userId: actor.id } }); return true;
      }
    }

    const appealId = path[0];
    if (!appealId) { sendJson(response, 404, { error: "Rota de apelações não encontrada." }); return true; }
    const store = appealStore(guild.id);
    const appeal = store.appeals.find(item => item.id === appealId);
    if (!appeal) throw Object.assign(new Error("Apelação não encontrada."), { status: 404 });

    if (request.method === "GET" && path.length === 1) {
      const userId = url.searchParams.get("userId");
      if (!ID_RE.test(String(userId || ""))) throw Object.assign(new Error("Usuário inválido."), { status: 400 });
      const member = await fetchMember(guild, userId);
      const perms = staffPermissions(member, guild, getGuildConfig(guild.id));
      const access = ensureAppealAccess(appeal, userId, perms);
      if (access === "staff") { appeal.unreadForStaff = false; }
      else { appeal.unreadForMember = false; }
      await persistAppealsStore();
      const profiles = store.profiles;
      const assignedProfile = appeal.assignedTo ? profiles[appeal.assignedTo] || null : null;
      sendJson(response, 200, { appeal: detail(appeal, access === "staff"), access, assignedProfile, permissions: perms }); return true;
    }

    if (request.method === "POST" && path[1] === "messages") {
      const body = await readJson(request, 6 * 1024 * 1024);
      const actor = actorFrom(body);
      const member = await fetchMember(guild, actor.id);
      const perms = staffPermissions(member, guild, getGuildConfig(guild.id));
      const access = ensureAppealAccess(appeal, actor.id, perms);
      if (access === "staff" && appeal.assignedTo !== actor.id && !perms.canManage) {
        throw Object.assign(new Error("Somente o atendente responsável ou um gerente pode conversar neste atendimento."), { status: 403 });
      }
      if (FINAL_STATES.has(appeal.status)) throw Object.assign(new Error("Este atendimento está encerrado. Reabra a apelação ou solicite à equipe que faça isso."), { status: 409 });
      const content = cleanText(body.content, MAX_MESSAGE_LENGTH);
      const attachments = validateAttachments(body.attachments || [], 4, 2 * 1024 * 1024);
      if (!content && !attachments.length) throw Object.assign(new Error("Escreva uma mensagem ou anexe uma evidência."), { status: 400 });
      const message = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, senderId: actor.id,
        senderName: access === "staff" ? (store.profiles[actor.id]?.displayName || actor.globalName || actor.username) : (actor.globalName || actor.username),
        senderAvatar: access === "staff" ? (store.profiles[actor.id]?.avatarUrl || actor.avatar) : actor.avatar,
        senderType: access, content, attachments, at: new Date().toISOString()
      };
      appeal.messages.push(message);
      appeal.updatedAt = message.at;
      if (access === "staff") { appeal.unreadForMember = true; appeal.unreadForStaff = false; if (appeal.status === "waiting_staff") appeal.status = "in_analysis"; }
      else { appeal.unreadForStaff = true; appeal.unreadForMember = false; if (appeal.status === "waiting_member") appeal.status = "in_analysis"; }
      addAudit(appeal, actor, "message_sent", { senderType: access, messageId: message.id });
      await persistAppealsStore();
      let delivery = { delivered: false, reason: "Notificação desativada." };
      if (access === "staff" && getAppealConfig(guild.id).notifyMemberOnStaffMessage) {
        delivery = await notifyUser(client, guild, appeal, `A alta staff enviou uma nova mensagem na sua apelação ${appeal.id}.`).catch(error => ({ delivered: false, reason: error.message }));
      } else if (access === "member" && getAppealConfig(guild.id).notifyStaffOnMemberMessage) {
        delivery = await notifyStaffChannel(client, guild, appeal, "Nova mensagem em uma apelação").catch(error => ({ delivered: false, reason: error.message }));
        if (!delivery.delivered) { addAudit(appeal, null, "staff_notification_failed", { delivery }); await persistAppealsStore(); }
      }
      if (access === "staff" && !delivery.delivered) await alertContactFailure(client, guild, appeal, "resposta da alta staff", delivery);
      sendJson(response, 201, { message: publicMessage(message), delivery, status: appeal.status }); return true;
    }

    if (request.method === "PATCH" && path.length === 2) {
      const body = await readJson(request);
      const actor = actorFrom(body);
      const member = await fetchMember(guild, actor.id);
      const perms = staffPermissions(member, guild, getGuildConfig(guild.id));
      if (path[1] === "assume") {
        canOperate(perms, "canAssume");
        if (appeal.assignedTo && appeal.assignedTo !== actor.id) throw Object.assign(new Error("Não é possível assumir essa apelação, outro atendente já está"), { status: 409 });
        if (FINAL_STATES.has(appeal.status)) throw Object.assign(new Error("Esta apelação já foi finalizada."), { status: 409 });
        appeal.assignedTo = actor.id;
        const profile = store.profiles[actor.id] || {};
        appeal.assignedProfile = { userId: actor.id, displayName: profile.displayName || actor.globalName || actor.username, avatarUrl: profile.avatarUrl || actor.avatar || null, description: profile.description || "", color: profile.color || "#ef1748" };
        appeal.status = "in_analysis"; appeal.updatedAt = new Date().toISOString();
        addAudit(appeal, actor, "appeal_assumed"); await persistAppealsStore();
        sendJson(response, 200, { appeal: summary(appeal) }); return true;
      }
      if (path[1] === "release") {
        if (!(perms.canManage || (perms.canAssume && appeal.assignedTo === actor.id))) throw Object.assign(new Error("Somente o responsável ou um gerente da Central pode liberar este atendimento."), { status: 403 });
        appeal.assignedTo = null; appeal.assignedProfile = null; appeal.status = "pending"; appeal.updatedAt = new Date().toISOString();
        addAudit(appeal, actor, "appeal_released"); await persistAppealsStore(); sendJson(response, 200, { appeal: summary(appeal) }); return true;
      }
      if (path[1] === "transfer") {
        canOperate(perms, "canManage");
        const targetId = String(body.targetStaffId || "");
        if (!ID_RE.test(targetId)) throw Object.assign(new Error("Selecione um atendente válido."), { status: 400 });
        const targetMember = await fetchMember(guild, targetId);
        const targetPermissions = staffPermissions(targetMember, guild, getGuildConfig(guild.id));
        if (!targetPermissions.canAssume) throw Object.assign(new Error("A pessoa selecionada não possui permissão para assumir apelações."), { status: 400 });
        appeal.assignedTo = targetId;
        const profile = store.profiles[targetId] || {};
        appeal.assignedProfile = { userId: targetId, displayName: profile.displayName || targetMember.displayName, avatarUrl: profile.avatarUrl || targetMember.user.displayAvatarURL({ extension: "png", size: 128 }), description: profile.description || "", color: profile.color || "#ef1748" };
        appeal.status = "in_analysis"; appeal.updatedAt = new Date().toISOString(); addAudit(appeal, actor, "appeal_transferred", { targetStaffId: targetId });
        await persistAppealsStore(); sendJson(response, 200, { appeal: summary(appeal) }); return true;
      }
      if (path[1] === "status") {
        const nextStatus = String(body.status || "");
        if (["accepted", "rejected"].includes(nextStatus)) {
          canOperate(perms, "canDecide");
          if (appeal.assignedTo !== actor.id && !perms.canManage) throw Object.assign(new Error("Somente o responsável pelo atendimento ou um gerente pode finalizar esta apelação."), { status: 403 });
          const reason = cleanText(body.justification, 2000);
          if (reason.length < 10) throw Object.assign(new Error("A justificativa precisa ter pelo menos 10 caracteres."), { status: 400 });
          appeal.decision = { status: nextStatus, justification: reason, by: actor.id, byName: actor.globalName || actor.username, at: new Date().toISOString() };
          appeal.status = nextStatus;
          addAudit(appeal, actor, nextStatus === "accepted" ? "appeal_accepted" : "appeal_rejected", { justification: reason });
          await persistAppealsStore();
          const cfg = getAppealConfig(guild.id);
          const message = nextStatus === "accepted" ? cfg.acceptedMessage : cfg.rejectedMessage;
          const delivery = await notifyUser(client, guild, appeal, `${message}\nJustificativa: ${reason}`).catch(error => ({ delivered: false, reason: error.message }));
          if (!delivery.delivered) await alertContactFailure(client, guild, appeal, `comunicação da decisão ${nextStatus}`, delivery);
          sendJson(response, 200, { appeal: summary(appeal), delivery }); return true;
        }
        canOperate(perms, "canManage");
        if (!new Set(["in_analysis", "waiting_member", "waiting_staff", "closed", "pending"]).has(nextStatus)) throw Object.assign(new Error("Estado de apelação inválido."), { status: 400 });
        appeal.status = nextStatus; appeal.updatedAt = new Date().toISOString();
        addAudit(appeal, actor, "appeal_status_changed", { status: nextStatus }); await persistAppealsStore();
        sendJson(response, 200, { appeal: summary(appeal) }); return true;
      }
      if (path[1] === "call") {
        canOperate(perms, "canView");
        if (appeal.assignedTo !== actor.id && !perms.canManage) throw Object.assign(new Error("Somente o responsável pelo atendimento ou um gerente pode chamar o membro."), { status: 403 });
        const delivery = await notifyUser(client, guild, appeal, "Olá! A alta staff quer conversar com você, por favor acesse o chat de apelações.").catch(error => ({ delivered: false, reason: error.message }));
        addAudit(appeal, actor, "member_called", delivery); appeal.updatedAt = new Date().toISOString();
        if (!delivery.delivered) await alertContactFailure(client, guild, appeal, "convite para atendimento", delivery);
        await persistAppealsStore();
        sendJson(response, delivery.delivered ? 200 : 502, { delivery, message: delivery.delivered ? "Convite enviado." : delivery.reason }); return true;
      }
      if (path[1] === "internal-note") {
        canOperate(perms, "canView");
        if (appeal.assignedTo !== actor.id && !perms.canManage) throw Object.assign(new Error("Somente o responsável pelo atendimento ou um gerente pode adicionar notas internas."), { status: 403 });
        const note = cleanText(body.note, 2000);
        if (note.length < 2) throw Object.assign(new Error("A nota interna está vazia."), { status: 400 });
        appeal.internalNotes ||= [];
        appeal.internalNotes.push({ authorId: actor.id, authorName: actor.globalName || actor.username, note, at: new Date().toISOString() });
        addAudit(appeal, actor, "internal_note_added"); await persistAppealsStore(); sendJson(response, 200, { ok: true }); return true;
      }
    }
    sendJson(response, 405, { error: "Método ou operação não permitido." }); return true;
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message || "Não foi possível concluir a operação." });
    return true;
  }
}
