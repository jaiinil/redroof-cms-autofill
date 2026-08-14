import { readFile } from 'node:fs/promises';

const LOG_FILE = 'output/action-log.jsonl';

/**
 * Builds a registry of room-type records we have already created, keyed by
 * `${parentRecordId}|${roomTypeCode}`. GetComponentData has been observed to
 * lag well behind CMS admin for newly created child records (root cause
 * unconfirmed), so it cannot be trusted alone to detect "does this already
 * exist" before deciding to create - this local, append-only log is the
 * source of truth that prevents duplicate creates regardless of that lag.
 */
export async function loadCreatedRegistry() {
  const registry = new Set();

  let raw;
  try {
    raw = await readFile(LOG_FILE, 'utf8');
  } catch {
    return registry;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.action !== 'createComponentRecord') continue;
    const success = entry.response?.Success ?? entry.response?.body?.Success;
    if (!success) continue;

    // Live-logged entries carry `records` (the raw API payload); retroactive
    // entries carry flat propertyCode/parentRecordId/roomTypeCode fields.
    if (Array.isArray(entry.records)) {
      for (const r of entry.records) {
        let roomTypeCode;
        try {
          roomTypeCode = JSON.parse(r.RecordJsonString)['room-type-code'];
        } catch {
          continue;
        }
        if (r.ParentRecordId && roomTypeCode) {
          registry.add(`${r.ParentRecordId}|${roomTypeCode.toUpperCase()}`);
        }
      }
    } else if (entry.parentRecordId && entry.roomTypeCode) {
      registry.add(`${entry.parentRecordId}|${entry.roomTypeCode.toUpperCase()}`);
    }
  }

  return registry;
}
