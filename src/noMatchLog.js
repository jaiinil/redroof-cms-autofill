import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const LOG_FILE = 'output/no-image-matches.jsonl';
const SUMMARY_FILE = 'output/no-image-matches-by-property.json';

/**
 * Records one "couldn't find a matching DAM image" case. Append-only, so
 * this is the durable source of truth for what still needs a human to sort
 * out - a missing DAM upload, a naming mismatch we can't fuzzy-resolve, etc.
 */
export async function recordNoMatch({ propertyCode, component, identifier, fileName, reason }) {
  await mkdir('output', { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    propertyCode,
    component, // 'listing-page-image' | 'gallery-images' | 'room-images'
    identifier, // e.g. room-type code, or gallery category
    fileName, // the reference-API filename we tried to find in DAM
    reason,
  });
  await appendFile(LOG_FILE, line + '\n');
}

/**
 * Rebuilds output/no-image-matches-by-property.json from the raw JSONL log,
 * grouped by property code, for easy human review.
 */
export async function summarizeNoMatchesByProperty() {
  let raw;
  try {
    raw = await readFile(LOG_FILE, 'utf8');
  } catch {
    raw = '';
  }

  const byProperty = {};
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!byProperty[entry.propertyCode]) byProperty[entry.propertyCode] = [];
    byProperty[entry.propertyCode].push(entry);
  }

  await mkdir('output', { recursive: true });
  await writeFile(SUMMARY_FILE, JSON.stringify(byProperty, null, 2));
  return byProperty;
}
