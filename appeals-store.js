import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const DB_FILE = path.join(DATA_DIR, "appeals.json");
let database = { guilds: {} };
let loaded = false;
let writeQueue = Promise.resolve();

export async function loadAppealsStore() {
  if (loaded) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(DB_FILE, "utf8"));
    if (parsed && parsed.guilds && typeof parsed.guilds === "object") database = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await persistAppealsStore();
  }
  loaded = true;
}

export function getAppealsGuild(guildId) {
  if (!database.guilds[guildId]) database.guilds[guildId] = { appeals: [], profiles: {} };
  const value = database.guilds[guildId];
  if (!Array.isArray(value.appeals)) value.appeals = [];
  if (!value.profiles || typeof value.profiles !== "object") value.profiles = {};
  return value;
}

export async function persistAppealsStore() {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const temp = `${DB_FILE}.tmp`;
    await fs.writeFile(temp, JSON.stringify(database, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, DB_FILE);
  });
  return writeQueue;
}

export function createAppealId() {
  return `FUT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}
