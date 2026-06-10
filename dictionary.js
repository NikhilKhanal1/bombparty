const fs = require('fs');
const path = require('path');

const MIN_WORDS = 5;

// ── Load words ──────────────────────────────────────────────────────────────
const raw = fs.readFileSync(path.join(__dirname, 'data', 'dictionary.txt'), 'utf8');
const validWords = new Set(
  raw.split('\n').map(w => w.trim()).filter(w => w.length > 0)
);

// ── Build prompt maps ───────────────────────────────────────────────────────
// substringCounts[len] maps substring -> number of distinct words containing it
const substringCounts = { 2: new Map(), 3: new Map(), 4: new Map() };

for (const word of validWords) {
  for (const len of [2, 3, 4]) {
    if (word.length < len) continue;
    const seen = new Set();
    for (let i = 0; i <= word.length - len; i++) {
      const sub = word.slice(i, i + len);
      if (!seen.has(sub)) {
        seen.add(sub);
        substringCounts[len].set(sub, (substringCounts[len].get(sub) || 0) + 1);
      }
    }
  }
}

// playablePrompts[len] = array of substrings appearing in >= MIN_WORDS distinct words
const playablePrompts = { 2: [], 3: [], 4: [] };
for (const len of [2, 3, 4]) {
  for (const [sub, count] of substringCounts[len]) {
    if (count >= MIN_WORDS) playablePrompts[len].push(sub);
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────

/**
 * Returns a random playable substring of the given length (2, 3, or 4).
 */
function generatePrompt(length) {
  const pool = playablePrompts[length];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Validates a word submission against the current prompt and used-word set.
 * Does NOT modify usedWords — caller adds the word after a successful play.
 *
 * Returns { valid: true } or { valid: false, reason: "..." }.
 */
function isValidWord(word, prompt, usedWords) {
  const w = word.trim().toLowerCase();
  if (!w.includes(prompt)) {
    return { valid: false, reason: `Word must contain "${prompt}".` };
  }
  if (!validWords.has(w)) {
    return { valid: false, reason: `"${w}" is not in the dictionary.` };
  }
  if (w.length < 3) {
    return { valid: false, reason: 'Word must be at least 3 letters long.' };
  }
  if (usedWords.has(w)) {
    return { valid: false, reason: `"${w}" has already been used.` };
  }
  return { valid: true };
}

module.exports = {
  validWords,
  substringCounts,
  playablePrompts,
  generatePrompt,
  isValidWord,
};
