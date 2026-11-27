import fs from "node:fs/promises";
import path from "node:path";
import { createDefaultGuildConfig } from "./defaults.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DB_FILE = path.join(DATA_DIR, "guilds.json");
let database = { guilds: {} };
let writeQueue = Promise.resolve();

function mergeDefaults(defaults, saved) {
  if (Array.isArray(defaults)) return Array.isArray(saved) ? saved : structuredClone(defaults);
  if (defaults && typeof defaults === "object") {
    const result = {};
    for (const [key, value] of Object.entries(defaults)) {
      result[key] = mergeDefaults(value, saved && Object.hasOwn(saved, key) ? saved[key] : undefined);
    }
    if (saved && typeof saved === "object") {
      for (const [key, value] of Object.entries(saved)) {
        if (!Object.hasOwn(result, key)) result[key] = value;
      }
    }
    return result;
  }
  return saved === undefined ? defaults : saved;
}

export async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.guilds && typeof parsed.guilds === "object") database = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await persist();
  }
}

export async function persist() {
  // Uma falha anterior não pode deixar a fila de gravação permanentemente rejeitada.
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temp = `${DB_FILE}.tmp`;
    await fs.writeFile(temp, JSON.stringify(database, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, DB_FILE);
  });
  return writeQueue;
}

export function getGuildConfig(guildId) {
  database.guilds[guildId] = mergeDefaults(createDefaultGuildConfig(), database.guilds[guildId] || {});
  return database.guilds[guildId];
}

export async function saveGuildConfig(guildId, config) {
  database.guilds[guildId] = config;
  await persist();
}

export function getDataDirectory() {
  return DATA_DIR;
}
