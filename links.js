const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+|(?<![@\w])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>]*)?/gi;
function cleanUrl(raw) {
  return String(raw || "")
    .replace(/[),.!?;:'"\]}]+$/g, "")
    .replace(/^www\./i, "https://www.");
}

export function extractUrls(text) {
  return [...String(text || "").matchAll(URL_PATTERN)].map(match => cleanUrl(match[0]));
}

function parseUrl(raw) {
  try {
    const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(value);
    if (!(["http:", "https:"].includes(url.protocol))) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host.includes("@")) return null;
    return { url, host, pathname: decodeURIComponent(url.pathname).toLowerCase() };
  } catch {
    return null;
  }
}

function hostMatches(host, rule) {
  const normalized = String(rule || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^\*\./, "").split(/[/:?#]/)[0].replace(/^www\./, "").replace(/\.$/, "");
  return Boolean(normalized && (host === normalized || host.endsWith(`.${normalized}`)));
}

function ruleMatches(parsed, rule) {
  const value = String(rule || "").trim();
  if (!value) return false;
  if (value.includes("/") || value.includes("?")) {
    const ruleParsed = parseUrl(value);
    if (ruleParsed) {
      return parsed.host === ruleParsed.host && parsed.url.pathname.toLowerCase().startsWith(ruleParsed.url.pathname.toLowerCase());
    }
  }
  return hostMatches(parsed.host, value);
}

function isGifVariant(parsed, config) {
  if (config.gifWhitelistEnabled === false) return false;
  const extensions = config.gifExtensions || [".gif", ".gifv"];
  return extensions.some(ext => parsed.pathname.endsWith(String(ext).toLowerCase()));
}

export function classifyLinks(message, config) {
  const urls = extractUrls(message);
  if (!urls.length) return { action: "none", urls: [] };

  const parsedUrls = urls.map(parseUrl);
  if (parsedUrls.some(item => !item)) return { action: "block", reason: "URL inválida ou esquema não permitido", urls };
  const parsed = parsedUrls;
  const blacklist = config.blacklist || [];
  const whitelist = config.whitelist || [];

  // A blacklist tem prioridade absoluta, inclusive sobre cargos e GIFs.
  const blocked = parsed.find(item => blacklist.some(rule => ruleMatches(item, rule)));
  if (blocked) return { action: "block", reason: `endereço presente na blacklist: ${blocked.host}`, urls };

  const trusted = parsed.every(item =>
    whitelist.some(rule => ruleMatches(item, rule)) || isGifVariant(item, config)
  );
  if (trusted) return { action: "allow", reason: "whitelist", urls };

  return { action: "review", reason: "link fora da whitelist", urls, parsed };
}

export function hasAuthorizedLinkRole(member, config) {
  const allowed = new Set(config.authorizedRoleIds || []);
  return member.roles.cache.some(role => allowed.has(role.id));
}

export function describeLinkLists(config) {
  return {
    whitelist: [...(config.whitelist || [])],
    blacklist: [...(config.blacklist || [])],
    gifExtensions: [...(config.gifExtensions || [])]
  };
}
