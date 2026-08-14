import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const LOG_FILE = 'output/no-reference-data.jsonl';
const SUMMARY_FILE = 'output/no-reference-data-by-property.json';

/**
 * Records one "reference API (RediStay) returned no room data for this
 * property" case - these properties get no room-type records at all
 * (nothing to create from), which is different from a DAM image-match
 * miss (see noMatchLog.js) or a CMS-side lookup failure.
 */
export async function recordNoReferenceData({ propertyCode, reason }) {
  await mkdir('output', { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), propertyCode, reason });
  await appendFile(LOG_FILE, line + '\n');
}

export async function summarizeNoReferenceDataByProperty() {
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
    byProperty[entry.propertyCode] = entry;
  }

  await mkdir('output', { recursive: true });
  await writeFile(SUMMARY_FILE, JSON.stringify(byProperty, null, 2));
  return byProperty;
}
