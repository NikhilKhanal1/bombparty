// scripts/build-tiers.js - rarity engine v2 offline builder (batch 50).
// Reads data/dictionary.txt + data/wordfreq-en.txt, writes data/tiers-v2.txt
// as "word<TAB>rarity" (rarity to 4 decimals). Run at dev time; the output
// file is committed. dictionary.js loads it and derives tiers via V2_CUTS.
'use strict';
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');

const freq = new Map();
for (const line of fs.readFileSync(path.join(DATA, 'wordfreq-en.txt'), 'utf8').split('\n')) {
  const t = line.trim(); if (!t || t[0] === '#') continue;
  const [w, z] = t.split('\t'); const zv = parseFloat(z);
  if (w && Number.isFinite(zv)) freq.set(w, zv);
}
const dictWords = fs.readFileSync(path.join(DATA, 'dictionary.txt'), 'utf8')
  .split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
const dict = new Set(dictWords);
const zipf = w => freq.get(w) || 0;
const fr = w => Math.min(1, Math.max(0, (7.5 - zipf(w)) / 7.5));

// Inflectional strips: cost 0 (a plural or tense is the same word to a player).
const INFL = [['ies','y'],['es',''],['s',''],['ed',''],['ed','e'],['ing',''],['ing','e'],['ings',''],['ings','e'],['er',''],['er','e'],['ers',''],['ers','e'],['est',''],['est','e'],['iest','y'],['ier','y']];
// Derivational strips: cost HOP each (knowing the stem does not mean producing
// the derivative under a ticking bomb).
const DERIV = [
  ['ily','y'],['ly',''],['ally',''],['ness',''],['iness','y'],['less',''],['ful',''],
  ['ment',''],['ments',''],['ation','ate'],['ations','ate'],
  ['isation','ise'],['ization','ize'],['isations','ise'],['izations','ize'],
  ['ize','e'],['ize',''],['ise','e'],['ise',''],['ism',''],['isms',''],['ist',''],['ists',''],
  ['al',''],['al','e'],['als',''],['als','e'],['ial',''],['ical',''],['ical','y'],
  ['ic',''],['ic','e'],['ic','a'],['ic','ia'],['ic','y'],['ics',''],
  ['ity',''],['ity','e'],['ities','ity'],['ities','e'],['ities',''],
  ['osity','ose'],['osities','ose'],['ousness','ous'],
  ['ous',''],['ous','e'],['ious','y'],['eous',''],
  ['fy',''],['fy','e'],['ify',''],['ify','y'],['efy',''],
  ['ance',''],['ence',''],['ancy',''],['ency',''],
  ['able',''],['able','e'],['ible',''],['ish',''],['dom',''],['hood',''],['ship',''],
  ['ian',''],['ian','y'],['ini',''],['ini','o'],['ette',''],['esque',''],
  ['oid',''],['oids',''],['age',''],['ery',''],['ry',''],
  ['ia',''],['y',''],['y','e'],
];
// Latin endings are gated: they only fire when the stripped target is itself a
// MEASURED word (heroon -> hero fires; random -on words do not chain blindly).
const LATIN = [['on',''],['um',''],['us',''],['ae','a'],['i','us'],['i','o']];
const PREFIXES = ['un','non','re','de','dis','mis','over','under','out','pre','post','anti','semi','super','sub','counter','fore','be','en','em','circum','auto','pseudo','proto','mono','poly','multi','inter','intra','trans','extra','micro','macro','neo','mid','co','bi','tri','di','hyper','hypo','ultra','mega','meta','para','peri','epi','iso'];
// Spelling variants: zero cost, but only when the respelling is measured
// (fantasm -> phantasm). Applied to unmeasured words only.
const VARIANTS = [['ph','f'],['f','ph'],['ae','e'],['oe','e'],['our','or'],['or','our'],['isation','ization'],['yse','yze'],['re','er']];
const HOP = 0.13, PFX = 0.10, CMP = 0.14;
const DOUBLED = new Set(['ing','ed','er','est']);
const VOW = new Set(['a','e','i','o','u']);

function neighbors(w) {
  const out = [];
  const push = (stem, cost) => { if (stem.length >= 3 && stem !== w && stem.length <= w.length) out.push([stem, cost]); };
  for (const [suf, rep] of INFL) {
    if (w.length > suf.length && w.endsWith(suf)) {
      const stem = w.slice(0, -suf.length) + rep;
      push(stem, 0);
      if (rep === '' && DOUBLED.has(suf) && stem.length >= 4 && stem[stem.length-1] === stem[stem.length-2] && !VOW.has(stem[stem.length-1])) push(stem.slice(0, -1), 0);
    }
  }
  for (const [suf, rep] of DERIV) if (w.length > suf.length && w.endsWith(suf)) push(w.slice(0, -suf.length) + rep, HOP);
  if (!freq.has(w)) {
    for (const [suf, rep] of LATIN) {
      if (w.length > suf.length && w.endsWith(suf)) { const st = w.slice(0, -suf.length) + rep; if (st.length >= 3 && st !== w && freq.has(st)) out.push([st, HOP]); }
    }
    for (const p of PREFIXES) if (w.length > p.length && w.startsWith(p)) push(w.slice(p.length), PFX);
    for (const [a, b] of VARIANTS) {
      const i = w.indexOf(a);
      if (i !== -1) { const v = w.slice(0, i) + b + w.slice(i + a.length); if (v !== w && v.length >= 3 && freq.has(v)) out.push([v, 0]); }
    }
  }
  return out;
}
function compoundProxy(w) {
  if (freq.has(w) || w.length < 8) return null;
  let best = null;
  for (let i = 4; i <= w.length - 4; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (!dict.has(a) || !dict.has(b)) continue;
    if (zipf(a) >= 2.5 && zipf(b) >= 2.5) { const r = Math.max(fr(a), fr(b)) + CMP; if (best === null || r < best) best = r; }
  }
  return best;
}
const memo = new Map();
const inProgress = new Set();
function morphRarity(w, depth = 0) {
  if (memo.has(w)) return memo.get(w);
  if (inProgress.has(w) || depth >= 6) return freq.has(w) ? fr(w) : 1;
  inProgress.add(w);
  let r = freq.has(w) ? fr(w) : 1;
  for (const [n, cost] of neighbors(w)) { const nr = morphRarity(n, depth + 1) + cost; if (nr < r) r = nr; }
  const cp = compoundProxy(w); if (cp !== null && cp < r) r = cp;
  r = Math.min(1, r);
  inProgress.delete(w);
  if (depth === 0) memo.set(w, r); // depth-limited sub-results are never cached
  return r;
}
// Order-4 character model over measured English, zipf-weighted: ranks the
// zero-signal residue by how English it looks. Residue maps by rank into
// [0.76, 1.00): plausible-looking residue can earn EPIC; the alien end is
// the legendary class.
const grams = new Map(), ctx = new Map();
for (const [w, z] of freq) {
  if (z < 1.5 || !/^[a-z]+$/.test(w)) continue;
  const s = '^^^' + w + '$';
  for (let i = 3; i < s.length; i++) {
    const c = s.slice(i - 3, i), g = s.slice(i - 3, i + 1);
    grams.set(g, (grams.get(g) || 0) + z); ctx.set(c, (ctx.get(c) || 0) + z);
  }
}
function ngramLP(w) {
  const s = '^^^' + w + '$'; let lp = 0;
  for (let i = 3; i < s.length; i++) {
    const c = s.slice(i - 3, i), g = s.slice(i - 3, i + 1);
    lp += Math.log(((grams.get(g) || 0) + 0.5) / ((ctx.get(c) || 0) + 13));
  }
  return lp / (s.length - 3);
}

const RES_LO = 0.76, RES_HI = 1.00;
const rar = new Map();
for (const w of dictWords) rar.set(w, morphRarity(w));
const residue = dictWords.filter(w => rar.get(w) >= 0.9999);
residue.map(w => [w, ngramLP(w)]).sort((a, b) => b[1] - a[1])
  .forEach(([w], i) => rar.set(w, RES_LO + (RES_HI - RES_LO) * (i / residue.length)));

// Tiers are decided HERE, at full precision, and stamped into the file. The
// runtime and the migration read the tier column verbatim; the rarity column
// (4 decimals) exists only for ordering (rarest-word pick) and display. This
// makes rounding drift across cut boundaries impossible by construction.
const CUTS = { c1: 0.44, c2: 0.60, c3: 0.74, c4: 0.985 };
const tier = r => r < CUTS.c1 ? 'COMMON' : r < CUTS.c2 ? 'UNCOMMON' : r < CUTS.c3 ? 'RARE' : r < CUTS.c4 ? 'EPIC' : 'LEGENDARY';
const out = dictWords.map(w => w + '\t' + rar.get(w).toFixed(4) + '\t' + tier(rar.get(w))).join('\n') + '\n';
fs.writeFileSync(path.join(DATA, 'tiers-v2.txt'), out);
const counts = {};
for (const w of dictWords) counts[tier(rar.get(w))] = (counts[tier(rar.get(w))] || 0) + 1;
console.log('wrote data/tiers-v2.txt', dictWords.length, 'words; residue', residue.length);
console.log('distribution:', JSON.stringify(counts));
