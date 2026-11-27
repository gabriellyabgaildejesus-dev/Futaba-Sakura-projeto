import http from "node:http";
import crypto from "node:crypto";
import { getGuildConfig, saveGuildConfig } from "./store.js";
import { applyGuildConfigPatch, serializeConfigForWeb, validateApiGuildAllowlist } from "./api-config.js";
import { handleAppealsApi } from "./appeals-api.js";

const MAX_BODY_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;

export function serializeGuildResources(guild) {
  const channels = [...guild.channels.cache.values()]
    .filter(channel => channel && !channel.isThread?.() && channel.isTextBased?.() && typeof channel.send === "function")
    .map(channel => ({ id: channel.id, name: channel.name, parentId: channel.parentId || null, parentName: channel.parent?.name || null, position: channel.position || 0, type: channel.type }))
    .sort((a, b) => (a.parentName || "").localeCompare(b.parentName || "") || a.position - b.position || a.name.localeCompare(b.name));
  const roles = [...guild.roles.cache.values()]
    .filter(role => role.id !== guild.id)
    .map(role => ({ id: role.id, name: role.name, position: role.position || 0, managed: Boolean(role.managed) }))
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
  return { guildId: guild.id, channels, roles };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function isAuthorized(request, secret) {
  const header = request.headers.authorization || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(secret);
  if (!supplied || suppliedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("Corpo da requisição muito grande."), { status: 413 });
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("JSON inválido."), { status: 400 });
  }
}

export function startApiServer(client) {
  const rawPort = process.env.API_PORT;
  if (!rawPort) return null;
  const port = Number(rawPort);
  const host = process.env.API_HOST || "0.0.0.0";
  const secret = process.env.FUTABA_API_SECRET || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("API_PORT inválida.");
  if (secret.length < 32) throw new Error("FUTABA_API_SECRET precisa ter pelo menos 32 caracteres quando API_PORT estiver definido.");

  const allowedGuilds = validateApiGuildAllowlist(
    process.env.POOL_PARTY_GUILD_ID,
    process.env.API_ALLOWED_GUILD_IDS
  );
  const rate = new Map();
  const server = http.createServer(async (request, response) => {
    const ip = request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const bucket = rate.get(ip) || { start: now, count: 0 };
    if (now - bucket.start >= RATE_WINDOW_MS) { bucket.start = now; bucket.count = 0; }
    bucket.count += 1;
    rate.set(ip, bucket);
    if (bucket.count > RATE_LIMIT) return sendJson(response, 429, { error: "Limite de requisições excedido." });

    let url;
    try { url = new URL(request.url || "/", "http://localhost"); }
    catch { return sendJson(response, 400, { error: "URL inválida." }); }
    if (request.method === "GET" && url.pathname === "/api/v1/health") {
      return sendJson(response, client.isReady() ? 200 : 503, { status: client.isReady() ? "online" : "starting" });
    }
    if (!isAuthorized(request, secret)) return sendJson(response, 401, { error: "Não autorizado." });

    const routeMatch = url.pathname.match(/^\/api\/v1\/guilds\/(\d{17,20})\/(config|resources|appeals(?:\/.*)?)$/);
    if (!routeMatch) return sendJson(response, 404, { error: "Rota não encontrada." });
    const guildId = routeMatch[1];
    const resource = routeMatch[2];
    if (!allowedGuilds.has(guildId)) return sendJson(response, 403, { error: "Servidor não autorizado para esta integração." });
    if (!client.isReady()) return sendJson(response, 503, { error: "O bot ainda está inicializando." });
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return sendJson(response, 404, { error: "A Futaba não está neste servidor." });

    if (resource === "appeals" || resource.startsWith("appeals/")) {
      const handled = await handleAppealsApi({ client, guild, request, response, url, sendJson, readJson });
      if (handled) return;
    }

    if (resource === "resources") {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        return sendJson(response, 405, { error: "Método não permitido." });
      }
      return sendJson(response, 200, serializeGuildResources(guild));
    }

    if (request.method === "GET") {
      return sendJson(response, 200, { guildId, config: serializeConfigForWeb(getGuildConfig(guildId)) });
    }
    if (request.method === "PATCH") {
      try {
        const body = await readJson(request);
        const previous = getGuildConfig(guildId);
        const next = applyGuildConfigPatch(previous, body.module, body.patch);
        await saveGuildConfig(guildId, next);
        if (body.module === "antiBot" && Array.isArray(body.patch?.trustedBotIds)) {
          const previousIds = new Set(previous.antiBot.trustedBotIds || []);
          const addedIds = (next.antiBot.trustedBotIds || []).filter(id => !previousIds.has(id));
          const pendingIds = addedIds.filter(botId => previous.antiBot.pending?.[botId]);
          if (pendingIds.length) {
            const { releaseTrustedBotFromQuarantine } = await import("./security.js");
            for (const botId of pendingIds) {
              await releaseTrustedBotFromQuarantine(client, guild, botId);
            }
          }
        }
        return sendJson(response, 200, { guildId, config: serializeConfigForWeb(next) });
      } catch (error) {
        return sendJson(response, error.status || 400, { error: error.message || "Não foi possível salvar a configuração." });
      }
    }
    response.setHeader("allow", "GET, PATCH");
    return sendJson(response, 405, { error: "Método não permitido." });
  });

  server.on("error", error => console.error(`[Futaba API] ${error.stack || error.message}`));
  server.listen(port, host, () => console.log(`[Futaba API] Escutando em ${host}:${port}`));
  return server;
}
