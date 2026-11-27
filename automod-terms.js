import { normalizeText } from "./security-utils.js";

/** Parse one term per line, removing empty and duplicate entries in this batch. */
export function parseAutoModTerms(value) {
  const terms = [];
  const seen = new Set();
  for (const raw of String(value ?? "").split(/\r?\n/)) {
    const term = raw.trim();
    if (!term) continue;
    const key = normalizeText(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

/** Add terms without a total-list cap; only each individual term is limited. */
export function addAutoModTerms(existing, incoming) {
  const terms = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(terms.map(normalizeText).filter(Boolean));
  let added = 0;

  for (const term of incoming) {
    if (term.length > 80) {
      throw new Error(`O termo "${term.slice(0, 30)}" ultrapassa o limite de 80 caracteres.`);
    }
    const key = normalizeText(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    added += 1;
  }

  return { terms, added, duplicates: incoming.length - added };
}

/** Remove exact normalized terms (case- and accent-insensitive). */
export function removeAutoModTerms(existing, removals) {
  const removeSet = new Set(removals.map(normalizeText).filter(Boolean));
  const current = Array.isArray(existing) ? existing : [];
  const existingKeys = new Set(current.map(normalizeText).filter(Boolean));
  const notFound = removals.filter(term => !existingKeys.has(normalizeText(term))).length;
  const terms = current.filter(term => !removeSet.has(normalizeText(term)));
  return { terms, removed: current.length - terms.length, notFound };
}
