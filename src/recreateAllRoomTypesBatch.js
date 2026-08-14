import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';
import { findPropertyImageAsset } from './clients/damClient.js';
import { createComponentRecord, buildRoomTypeRecordPayload } from './clients/miblockCreateClient.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';
import { deleteComponentRecord } from './clients/miblockDeleteClient.js';
import { getProfileIdForPropertyCode } from './clients/profileClient.js';
import { loadCreatedRecordIdsForParent } from './createdRegistry.js';
import { recordNoReferenceData } from './noReferenceDataLog.js';
import { recordCompleted } from './completedPropertiesLog.js';

const ROOM_TYPE_MIBLOCK_ID = 20135;
const PROPERTY_DATA_MIBLOCK_ID = 20132;
const SITE_ID = 17677;
const CONCURRENCY = 3;
const EMPTY_RESPONSE_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getPropertyRecordsWithRetry(propertyCode) {
  let propertyRecords = [];
  for (let attempt = 1; attempt <= EMPTY_RESPONSE_RETRIES; attempt++) {
    const cmsData = await getComponentData(propertyCode);
    propertyRecords = cmsData.MainFilterObj || [];
    if (propertyRecords.length) break;
    if (attempt < EMPTY_RESPONSE_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
  }
  return propertyRecords;
}

export async function recreateRoomTypesForProperty(propertyCode) {
  const propertyRecords = await getPropertyRecordsWithRetry(propertyCode);
  if (!propertyRecords.length) {
    return { propertyCode, status: 'no-property-record' };
  }

  const profileId = await getProfileIdForPropertyCode(propertyCode);

  const referenceData = await getWebContent([propertyCode]);
  const referenceRooms = referenceData?.Data?.Results?.[0]?.RoomDetails || [];
  if (!referenceRooms.length) {
    await recordNoReferenceData({ propertyCode, reason: 'RediStay reference API returned no RoomDetails for this property' });
    return { propertyCode, status: 'no-reference-rooms' };
  }

  const perParent = [];

  for (const propertyRecord of propertyRecords) {
    // Clear out any leftover room-type records first (live read unioned
    // with action-log history, so a read-lag miss can't leave a stale
    // duplicate - see the RRI207 incident this pattern was built for).
    const liveIds = (propertyRecord.ChildRecords || [])
      .filter((r) => r.ComponentAliasName === 'room-type')
      .map((r) => r.Id);
    const loggedIds = await loadCreatedRecordIdsForParent(propertyRecord.Id);
    const idsToDelete = [...new Set([...liveIds, ...loggedIds])];
    if (idsToDelete.length) {
      await deleteComponentRecord({ miBlockId: ROOM_TYPE_MIBLOCK_ID, recordIds: idsToDelete });
    }

    const roomResults = [];
    for (const refRoom of referenceRooms) {
      const code = refRoom.RoomType;
      const fileName = refRoom.ThumbnailImage?.Image?.FileName
        || (() => { try { return new URL(refRoom.RoomImageImgUrl).pathname.split('/').pop(); } catch { return null; } })();

      const record = buildRoomTypeRecordPayload({
        parentRecordId: propertyRecord.Id,
        miBlockId: ROOM_TYPE_MIBLOCK_ID,
        parentMiBlockId: PROPERTY_DATA_MIBLOCK_ID,
        siteId: SITE_ID,
        roomTypeCode: code,
        roomTypeDescription: refRoom.RoomDescription,
        roomImagesAlt: refRoom.RoomImageAltText,
        profileId,
      });

      const createResult = await createComponentRecord({ componentAliasName: 'Room Type', records: [record] });
      const newRecordId = createResult.body?.componentRecordDetails?.recordsDetails?.[0]?.recordId;

      if (!createResult.body?.Success || !newRecordId) {
        roomResults.push({ code, created: false, error: createResult.body?.ErrorMessage });
        continue;
      }

      const damMatch = await findPropertyImageAsset(propertyCode, fileName);
      if (!damMatch) {
        roomResults.push({ code, created: true, recordId: newRecordId, imageLinked: false, noDamMatch: fileName });
        continue;
      }

      const imageResult = await updateMiblockRecordAsset({
        miBlockId: ROOM_TYPE_MIBLOCK_ID,
        recordId: newRecordId,
        assetFields: [{ fieldAlias: 'room-images', assetUrls: [damMatch.asset.assetPath] }],
      });
      roomResults.push({
        code,
        created: true,
        recordId: newRecordId,
        imageLinked: !!imageResult.fieldStatuses?.[0]?.Success,
      });
    }

    perParent.push({ parentRecordId: propertyRecord.Id, profileId, deletedBeforeRecreate: idsToDelete, rooms: roomResults });
  }

  return { propertyCode, status: 'ok', perParent };
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function main() {
  const [, , startIndexArg, batchSizeArg] = process.argv;
  const startIndex = parseInt(startIndexArg, 10) || 0;
  const batchSize = parseInt(batchSizeArg, 10) || 100;

  const allCodes = JSON.parse(await readFile('output/property-codes.json', 'utf8'));
  const slice = allCodes.slice(startIndex, startIndex + batchSize);
  console.log(`Recreating room-types for ${slice.length} properties (index ${startIndex} to ${startIndex + slice.length - 1} of ${allCodes.length})`);

  let done = 0;
  const summary = [];

  await runWithConcurrency(slice, CONCURRENCY, async (code) => {
    try {
      const result = await recreateRoomTypesForProperty(code);
      summary.push(result);
      await recordCompleted(code, result.status);
    } catch (err) {
      summary.push({ propertyCode: code, status: 'error', error: err.message });
      await recordCompleted(code, 'error');
    } finally {
      done += 1;
      if (done % 20 === 0 || done === slice.length) console.log(`Progress: ${done}/${slice.length}`);
    }
  });

  await mkdir('output', { recursive: true });
  const outFile = `output/recreate-batch-${startIndex}-${startIndex + slice.length}.json`;
  await writeFile(outFile, JSON.stringify(summary, null, 2));

  const masterFile = 'output/recreated-room-types-by-property.json';
  let master = {};
  try {
    master = JSON.parse(await readFile(masterFile, 'utf8'));
  } catch {
    master = {};
  }
  for (const s of summary) {
    master[s.propertyCode] = { ...s, timestamp: new Date().toISOString() };
  }
  await writeFile(masterFile, JSON.stringify(master, null, 2));

  const totals = summary.reduce(
    (acc, s) => {
      if (s.status === 'error') acc.errors += 1;
      else if (s.status === 'no-property-record') acc.noPropertyRecord += 1;
      else if (s.status === 'no-reference-rooms') acc.noReferenceRooms += 1;
      else {
        acc.ok += 1;
        for (const p of s.perParent || []) {
          for (const r of p.rooms || []) {
            if (r.created) acc.roomsCreated += 1;
            if (r.imageLinked) acc.imagesLinked += 1;
          }
        }
      }
      return acc;
    },
    { ok: 0, errors: 0, noPropertyRecord: 0, noReferenceRooms: 0, roomsCreated: 0, imagesLinked: 0 }
  );

  console.log('\n--- Batch summary ---');
  console.log(`Properties: ${slice.length} | OK: ${totals.ok} | No property record: ${totals.noPropertyRecord} | No reference rooms: ${totals.noReferenceRooms} | Errors: ${totals.errors}`);
  console.log(`Rooms created: ${totals.roomsCreated} | Images linked: ${totals.imagesLinked}`);
  console.log(`Detail: ${outFile}`);
  console.log(`Master file updated: ${masterFile} (${Object.keys(master).length} properties tracked so far)`);

  const errored = summary.filter((s) => s.status === 'error');
  if (errored.length) {
    console.log('\n--- Errors ---');
    for (const e of errored) console.log(`${e.propertyCode}: ${e.error}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
