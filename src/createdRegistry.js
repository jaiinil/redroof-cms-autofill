import { readFile } from 'node:fs/promises';

const LOG_FILE = 'output/action-log.jsonl';

/**
 * Walks action-log.jsonl and returns every room-type create/delete outcome
 * in order: { parentRecordId, roomTypeCode, recordId, deleted }. `recordId`
 * comes from the create response (`recordsDetails[0].recordId`) when
 * available; retroactively-logged entries that predate that field are
 * skipped for recordId purposes (they still count for the Set-based
 * registry below, keyed on code only).
 */
async function readCreateDeleteEvents() {
  const events = [];

  let raw;
  try {
    raw = await readFile(LOG_FILE, 'utf8');
  } catch {
    return events;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.action === 'createComponentRecord') {
      const success = entry.response?.Success ?? entry.response?.body?.Success;
      if (!success) continue;

      if (Array.isArray(entry.records)) {
        const createdIds = entry.response?.componentRecordDetails?.recordsDetails
          ?? entry.response?.body?.componentRecordDetails?.recordsDetails
          ?? [];
        entry.records.forEach((r, i) => {
          let roomTypeCode;
          try {
            roomTypeCode = JSON.parse(r.RecordJsonString)['room-type-code'];
          } catch {
            return;
          }
          if (!r.ParentRecordId || !roomTypeCode) return;
          events.push({
            parentRecordId: r.ParentRecordId,
            roomTypeCode: roomTypeCode.toUpperCase(),
            recordId: createdIds[i]?.recordId ?? null,
            deleted: false,
          });
        });
      } else if (entry.parentRecordId && entry.roomTypeCode) {
        // Retroactively-logged entries - recordId lives under recordIdCreated.
        events.push({
          parentRecordId: entry.parentRecordId,
          roomTypeCode: entry.roomTypeCode.toUpperCase(),
          recordId: entry.recordIdCreated ?? null,
          deleted: false,
        });
      }
    }

    if (entry.action === 'deleteComponentRecord') {
      const success = entry.response?.Success ?? entry.response?.body?.Success;
      if (!success) continue;
      for (const id of entry.recordIds || []) {
        events.push({ parentRecordId: null, roomTypeCode: null, recordId: id, deleted: true });
      }
    }
  }

  return events;
}

/**
 * Builds a registry of room-type records we have already created (and not
 * since deleted), keyed by `${parentRecordId}|${roomTypeCode}`.
 * GetComponentData has been observed to lag well behind CMS admin for
 * newly created child records (root cause unconfirmed), so it cannot be
 * trusted alone to detect "does this already exist" before deciding to
 * create - this local, append-only log is the source of truth that
 * prevents duplicate creates regardless of that lag.
 */
export async function loadCreatedRegistry() {
  const events = await readCreateDeleteEvents();
  const deletedIds = new Set(events.filter((e) => e.deleted).map((e) => e.recordId));

  const registry = new Set();
  for (const e of events) {
    if (e.deleted || !e.parentRecordId || !e.roomTypeCode) continue;
    if (e.recordId && deletedIds.has(e.recordId)) continue; // created then later deleted - no longer "exists"
    registry.add(`${e.parentRecordId}|${e.roomTypeCode}`);
  }
  return registry;
}

/**
 * Returns every room-type recordId we have ever created for a given
 * property-data parent, EXCLUDING ones we've since deleted (per the same
 * log) - used to build a complete delete-target list that doesn't miss a
 * record just because GetComponentData hasn't caught up to it yet.
 */
export async function loadCreatedRecordIdsForParent(parentRecordId) {
  const events = await readCreateDeleteEvents();
  const deletedIds = new Set(events.filter((e) => e.deleted).map((e) => e.recordId));

  const ids = new Set();
  for (const e of events) {
    if (e.deleted || e.parentRecordId !== parentRecordId || !e.recordId) continue;
    if (deletedIds.has(e.recordId)) continue;
    ids.add(e.recordId);
  }
  return [...ids];
}
