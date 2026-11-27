import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

export function passwordIsConfigured(antiBotConfig) {
  return Boolean(antiBotConfig?.password?.salt && antiBotConfig?.password?.hash);
}

export function validateNewPassword(password) {
  const value = String(password || "");
  if (value.length < 12 || value.length > 128) {
    return "A senha precisa ter entre 12 e 128 caracteres.";
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) {
    return "Use pelo menos uma letra minúscula, uma maiúscula e um número.";
  }
  return null;
}

export async function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
  return { salt, hash: derived.toString("hex") };
}

export async function verifyPassword(password, record) {
  if (!record?.salt || !record?.hash) return false;
  const derived = await scrypt(String(password || ""), record.salt, KEY_LENGTH, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(record.hash, "hex");
  const actual = Buffer.from(derived.toString("hex"), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
