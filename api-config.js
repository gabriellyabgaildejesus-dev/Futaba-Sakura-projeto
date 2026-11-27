import { createDefaultGuildConfig } from "./defaults.js";
import { safeHttpsUrl } from "./security-utils.js";

const INTERNAL_ANTIBOT_FIELDS = new Set(["password", "pending", "blockedBotIds"]);
const INTERNAL_FIELDS = new Set(["verificationLevelBeforeLockdown", "lockdownUntil"]);
const SNOWFLAKE_LISTS = new Set(["watchChannelIds", "staffRoleIds", "authorizedRoleIds", "trustedBotIds", "viewRoleIds", "assumeRoleIds", "decideRoleIds", "manageRoleIds"]);
const MAX_ARRAY_LENGTH = 5000;

export function validateApiGuildAllowlist(poolPartyGuildId, configuredIds) {
  const allowed = String(configuredIds || "").split(",").map(value => value.trim()).filter(Boolean);
  if (!/^\d{17,20}$/.test(String(poolPartyGuildId || ""))) {
    throw new Error("POOL_PARTY_GUILD_ID precisa conter o ID real do servidor oficial.");
  }
  if (allowed.length !== 1 || allowed[0] !== poolPartyGuildId) {
    throw new Error("API_ALLOWED_GUILD_IDS deve conter somente o mesmo ID de POOL_PARTY_GUILD_ID.");
  }
  return new Set(allowed);
}

function isSnowflake(value) {
  return /^\d{17,20}$/.test(String(value));
}

function validateArray(moduleKey, field, value) {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_LENGTH) {
    throw new Error(`${field}: envie uma lista válida com até ${MAX_ARRAY_LENGTH} itens.`);
  }
  const cleaned = value.map(item => {
    if (typeof item !== "string") throw new Error(`${field}: todos os itens precisam ser textos.`);
    const text = item.trim();
    if (!text || text.length > 500) throw new Error(`${field}: há um item vazio ou muito longo.`);
    if (SNOWFLAKE_LISTS.has(field) && !isSnowflake(text)) throw new Error(`${field}: ID inválido (${text}).`);
    return text;
  });
  if (field === "bannerUrl") throw new Error("Campo de banner inválido.");
  if (moduleKey === "antiLink" && field === "gifExtensions" && cleaned.some(item => !/^\.[a-z0-9]{2,8}$/i.test(item))) {
    throw new Error("gifExtensions: use extensões como .gif ou .gifv.");
  }
  if (moduleKey === "antiLink" && ["whitelist", "blacklist"].includes(field)) {
    for (const item of cleaned) {
      if (/\s/.test(item) || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?$/i.test(item)) {
        throw new Error(`${field}: regra inválida (${item}). Use domínio ou caminho sem espaços.`);
      }
    }
  }
  return [...new Set(cleaned)];
}

function validateField(moduleKey, field, value, defaultValue) {
  if ((INTERNAL_ANTIBOT_FIELDS.has(field) && moduleKey === "antiBot") || INTERNAL_FIELDS.has(field)) {
    throw new Error(`O site não pode alterar o campo interno ${field}.`);
  }
  if (Array.isArray(defaultValue)) return validateArray(moduleKey, field, value);
  if (typeof defaultValue === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${field}: esperado true ou false.`);
    return value;
  }
  if (typeof defaultValue === "number") {
    const min = moduleKey === "general" && field === "defaultClearCount" ? 1 : 0;
    const max = moduleKey === "general" && field === "defaultClearCount" ? 1000 : 2_419_200_000;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${field}: informe um número inteiro dentro do limite permitido.`);
    }
    return value;
  }
  if (defaultValue === null) {
    if (value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 500) throw new Error(`${field}: valor inválido.`);
    if (field === "bannerUrl") {
      const valid = safeHttpsUrl(value);
      if (!valid) throw new Error("bannerUrl precisa ser uma URL HTTPS válida.");
      return valid;
    }
    if (field.endsWith("ChannelId") || field.endsWith("RoleId")) {
      if (!isSnowflake(value)) throw new Error(`${field}: ID do Discord inválido.`);
    }
    if (field.endsWith("Url")) {
      const valid = safeHttpsUrl(value);
      if (!valid) throw new Error(`${field} precisa ser uma URL HTTPS válida.`);
      return valid;
    }
    return value;
  }
  if (typeof defaultValue === "string") {
    if (typeof value !== "string") throw new Error(`${field}: esperado texto.`);
    if (moduleKey === "general" && field === "prefix" && (!value || value.length > 3 || /\s|@|<|>/u.test(value))) throw new Error("prefix deve ter de 1 a 3 caracteres e não pode conter espaços ou menções.");
    if (field.endsWith("Color") && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${field} deve estar no formato #RRGGBB.`);
    const max = field === "publicMessage" || field === "dmMessage" || field.endsWith("Description") ? 4000 : 2048;
    if (value.length > max) throw new Error(`${field}: limite de ${max} caracteres.`);
    if (field === "bannerUrl" && value) {
      const valid = safeHttpsUrl(value);
      if (!valid) throw new Error("bannerUrl precisa ser uma URL HTTPS válida.");
      return valid;
    }
    return value;
  }
  throw new Error(`${field}: tipo de configuração não suportado pela API.`);
}

export function applyGuildConfigPatch(currentConfig, moduleKey, patch) {
  const defaults = createDefaultGuildConfig();
  if (!Object.hasOwn(defaults, moduleKey)) throw new Error("Módulo desconhecido.");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("patch precisa ser um objeto.");
  const moduleDefaults = defaults[moduleKey];
  const next = structuredClone(currentConfig);
  const target = next[moduleKey] || structuredClone(moduleDefaults);
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error("Nenhuma alteração foi enviada.");
  for (const field of keys) {
    if (!Object.hasOwn(moduleDefaults, field)) throw new Error(`Campo não reconhecido: ${field}.`);
    if (moduleKey === "general" && field === "punishmentEmbed") {
      const incoming = patch[field];
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) throw new Error("punishmentEmbed precisa ser um objeto.");
      const currentEmbed = { ...moduleDefaults.punishmentEmbed, ...(target.punishmentEmbed || {}) };
      const allowed = new Set(Object.keys(moduleDefaults.punishmentEmbed));
      for (const [embedField, value] of Object.entries(incoming)) {
        if (!allowed.has(embedField)) throw new Error(`Campo de embed não reconhecido: ${embedField}.`);
        if (embedField === "imageUrl" || embedField === "thumbnailUrl") {
          if (value === null || value === "") currentEmbed[embedField] = null;
          else {
            const valid = safeHttpsUrl(value);
            if (!valid) throw new Error(`${embedField} precisa ser uma URL HTTPS válida.`);
            currentEmbed[embedField] = valid;
          }
        } else if (["authorIconUrl", "footerIconUrl"].includes(embedField)) {
          if (value === null || value === "") currentEmbed[embedField] = null;
          else {
            const valid = safeHttpsUrl(value);
            if (!valid) throw new Error(`${embedField} precisa ser HTTPS.`);
            currentEmbed[embedField] = valid;
          }
        } else if (embedField === "fields") {
          currentEmbed.fields = validateArray("general", embedField, value);
        } else if (["timestamp", "includeDefaultFields"].includes(embedField)) {
          if (typeof value !== "boolean") throw new Error(`${embedField} precisa ser booleano.`);
          currentEmbed[embedField] = value;
        } else if (embedField === "color") {
          if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("A cor do embed deve estar no formato #RRGGBB.");
          currentEmbed.color = value;
        } else {
          if (typeof value !== "string" || value.length > (embedField === "description" ? 4000 : 2048)) throw new Error(`${embedField} inválido ou muito longo.`);
          currentEmbed[embedField] = value;
        }
      }
      target.punishmentEmbed = currentEmbed;
    } else {
      target[field] = validateField(moduleKey, field, patch[field], moduleDefaults[field]);
    }
  }
  next[moduleKey] = target;
  return next;
}

export function serializeConfigForWeb(config) {
  const safe = structuredClone(config);
  delete safe.moderationHistory;
  delete safe.channelLocks;
  if (safe.antiBot) {
    const configured = Boolean(safe.antiBot.password?.salt && safe.antiBot.password?.hash);
    delete safe.antiBot.password;
    delete safe.antiBot.pending;
    delete safe.antiBot.blockedBotIds;
    safe.antiBot.passwordConfigured = configured;
  }
  return safe;
}
