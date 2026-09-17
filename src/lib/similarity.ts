// Simple string similarity (Levenshtein-based ratio) plus Vietnamese-aware
// normalization, used to match messy/unaccented Vietnamese product & customer
// names against aliases without adding an extra dependency.

/** Strips Vietnamese diacritics, lowercases, and collapses whitespace/punctuation. */
export function normalizeVN(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining accent marks
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  const matrix: number[][] = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) matrix[i][0] = i;
  for (let j = 0; j <= bl; j++) matrix[0][j] = j;

  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[al][bl];
}

/** Returns a similarity ratio between 0 (no match) and 1 (identical), comparing accent-stripped forms. */
export function similarity(a: string, b: string): number {
  const s1 = normalizeVN(a);
  const s2 = normalizeVN(b);
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) {
    return 0.9 * (Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length)) + 0.1;
  }
  const dist = levenshtein(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - dist / maxLen;
}

export interface Match<T> {
  item: T;
  score: number;
  matchedOn: "name" | "alias";
  matchedText: string;
}

/**
 * Finds entries in `candidates` whose name OR any alias is similar to `query`.
 * Exact (normalized) matches on name/alias always score 1, so aliases behave
 * like first-class names once learned.
 */
export function findSimilarWithAliases<T>(
  query: string,
  candidates: T[],
  getName: (item: T) => string,
  getAliases: (item: T) => string[],
  threshold = 0.55
): Match<T>[] {
  const results: Match<T>[] = [];
  for (const item of candidates) {
    const name = getName(item);
    let best: Match<T> = { item, score: similarity(query, name), matchedOn: "name", matchedText: name };
    for (const alias of getAliases(item)) {
      const score = similarity(query, alias);
      if (score > best.score) best = { item, score, matchedOn: "alias", matchedText: alias };
    }
    if (best.score >= threshold) results.push(best);
  }
  return results.sort((a, b) => b.score - a.score);
}

/** Back-compat simple variant (no aliases) used by generic name-only lists. */
export function findSimilar<T>(
  query: string,
  candidates: T[],
  getName: (item: T) => string,
  threshold = 0.55
): Match<T>[] {
  return findSimilarWithAliases(query, candidates, getName, () => [], threshold);
}
