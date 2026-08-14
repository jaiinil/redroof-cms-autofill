import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const LOG_FILE = 'output/completed-properties.jsonl';
const SUMMARY_FILE = 'output/completed-properties-list.json';

/**
 * Records that a property has finished going through the recreate pipeline
 * (regardless of outcome - ok, no-reference-rooms, no-property-record, or
 * error all count as "processed"). Simple progress tracker, separate from
 * the full-detail master file, so "which properties are done" is a quick
 * glance rather than parsing the detailed result blob.
 */
export async function recordCompleted(propertyCode, status) {
  await mkdir('output', { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), propertyCode, status });
  await appendFile(LOG_FILE, line + '\n');
}

export async function summarizeCompletedProperties() {
  let raw;
  try {
    raw = await readFile(LOG_FILE, 'utf8');
  } catch {
    raw = '';
  }

  const completed = {};
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    completed[entry.propertyCode] = { status: entry.status, timestamp: entry.timestamp };
  }

  await mkdir('output', { recursive: true });
  await writeFile(SUMMARY_FILE, JSON.stringify(completed, null, 2));
  return completed;
}
