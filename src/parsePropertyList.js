import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

// Parses the messy copy-pasted CMS property listing into structured rows,
// then flags duplicate/suspicious property codes before anything is used
// to drive automation against production.

const raw = readFileSync('data/property-codes-raw.txt', 'utf8');

const CODE_RE = /^[A-Za-z]{2,4}\d{2,5}$/;

const lines = raw.split('\n').map((l) => l.trim());

const records = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  if (CODE_RE.test(line)) {
    const code = line;
    const name = lines[i + 1] || '';
    const index = lines[i + 2] || '';
    const publishedState = lines[i + 3] || '';
    const status = lines[i + 4] || '';
    records.push({ code, name, index, publishedState, status, lineNo: i + 1 });
    i += 5;
  } else {
    i += 1;
  }
}

// Group by normalized (uppercased) code
const byNormCode = new Map();
for (const r of records) {
  const norm = r.code.toUpperCase();
  if (!byNormCode.has(norm)) byNormCode.set(norm, []);
  byNormCode.get(norm).push(r);
}

const unique = [];
const flagged = [];

for (const [norm, group] of byNormCode) {
  if (group.length === 1) {
    unique.push(group[0]);
    continue;
  }

  // Multiple entries for the same code. Distinguish:
  // - exact re-listing of the same property (same name) -> duplicate, keep one
  // - same code reused for a DIFFERENT property name -> real conflict, needs a human
  // - code differs only in case (rri902 vs RRI902-style) -> normalize, flag for awareness
  const distinctNames = new Set(group.map((g) => g.name.trim().toLowerCase()));
  const hasCaseVariants = new Set(group.map((g) => g.code)).size > 1;

  unique.push({ ...group[0], code: norm }); // keep first, normalized to uppercase

  flagged.push({
    code: norm,
    occurrences: group.length,
    hasCaseVariants,
    distinctNames: [...distinctNames],
    conflictingNames: distinctNames.size > 1,
    entries: group,
  });
}

// Codes that appeared only once but were typed in lowercase in the source -
// not a duplicate, but a data-entry inconsistency worth a human's eyes.
const lowercaseSingles = records.filter(
  (r) => r.code !== r.code.toUpperCase() && byNormCode.get(r.code.toUpperCase()).length === 1
);

mkdirSync('output', { recursive: true });
writeFileSync('output/property-codes.json', JSON.stringify(unique.map((r) => r.code).sort(), null, 2));
writeFileSync('output/property-codes-full.json', JSON.stringify(unique, null, 2));
writeFileSync('output/property-codes-flagged.json', JSON.stringify(flagged, null, 2));

console.log(`Parsed records: ${records.length}`);
console.log(`Unique property codes: ${unique.length}`);
console.log(`Codes with duplicate/conflicting entries: ${flagged.length}`);
console.log(`Codes typed in lowercase in source (normalized to uppercase): ${lowercaseSingles.length}`);
if (lowercaseSingles.length) {
  for (const r of lowercaseSingles) {
    console.log(`    [line ${r.lineNo}] code="${r.code}" -> normalized "${r.code.toUpperCase()}" name="${r.name}"`);
  }
}
if (flagged.length) {
  console.log('\n--- Flagged ---');
  for (const f of flagged) {
    console.log(
      `${f.code} | occurrences: ${f.occurrences} | case-variants: ${f.hasCaseVariants} | conflicting-names: ${f.conflictingNames}`
    );
    for (const e of f.entries) {
      console.log(`    [line ${e.lineNo}] code="${e.code}" name="${e.name}" index=${e.index} status=${e.status}`);
    }
  }
}
