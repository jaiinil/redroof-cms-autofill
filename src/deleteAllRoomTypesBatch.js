import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getComponentData } from './clients/cmsClient.js';
import { deleteComponentRecord } from './clients/miblockDeleteClient.js';
import { loadCreatedRecordIdsForParent } from './createdRegistry.js';

const ROOM_TYPE_MIBLOCK_ID = 20135;
const CONCURRENCY = 3; // lowered from 5 - a 500-property run at concurrency 5 caused transient
                        // empty responses from GetComponentData for ~40% of properties (confirmed
                        // false negatives - every one succeeded on an immediate retry). Retry logic
                        // below is the real fix; this is just extra headroom.
const EMPTY_RESPONSE_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Usage: node src/deleteAllRoomTypesBatch.js <startIndex> <batchSize>
// Deletes every room-type record (live CMS read unioned with action-log
// history) for a slice of output/property-codes.json. Delete-only, no
// recreate. PERMANENT.
const [, , startIndexArg, batchSizeArg] = process.argv;
const startIndex = parseInt(startIndexArg, 10) || 0;
const batchSize = parseInt(batchSizeArg, 10) || 100;

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

export async function deleteRoomTypesForProperty(propertyCode) {
  // GetComponentData has been observed to return an empty MainFilterObj
  // transiently under load (confirmed: every "no-property-record" result
  // from a 500-wide batch succeeded on an immediate manual retry) - retry
  // before concluding a property genuinely has no CMS record, since that
  // conclusion causes us to silently skip it.
  let propertyRecords = [];
  for (let attempt = 1; attempt <= EMPTY_RESPONSE_RETRIES; attempt++) {
    const cmsData = await getComponentData(propertyCode);
    propertyRecords = cmsData.MainFilterObj || [];
    if (propertyRecords.length) break;
    if (attempt < EMPTY_RESPONSE_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
  }
  if (!propertyRecords.length) {
    return { propertyCode, status: 'no-property-record', deletedCount: 0 };
  }

  let totalDeleted = 0;
  const perParent = [];

  for (const pr of propertyRecords) {
    const liveIds = (pr.ChildRecords || [])
      .filter((r) => r.ComponentAliasName === 'room-type')
      .map((r) => r.Id);
    const loggedIds = await loadCreatedRecordIdsForParent(pr.Id);
    const allIds = [...new Set([...liveIds, ...loggedIds])];

    if (allIds.length) {
      const result = await deleteComponentRecord({ miBlockId: ROOM_TYPE_MIBLOCK_ID, recordIds: allIds });
      perParent.push({ parentRecordId: pr.Id, ids: allIds, success: result.body?.Success, error: result.body?.ErrorMessage });
      if (result.body?.Success) totalDeleted += allIds.length;
    } else {
      perParent.push({ parentRecordId: pr.Id, ids: [], success: true, error: null });
    }
  }

  return { propertyCode, status: 'ok', deletedCount: totalDeleted, perParent };
}

async function main() {
  const allCodes = JSON.parse(await readFile('output/property-codes.json', 'utf8'));
  const slice = allCodes.slice(startIndex, startIndex + batchSize);
  console.log(`Processing ${slice.length} properties (index ${startIndex} to ${startIndex + slice.length - 1} of ${allCodes.length})`);

  let done = 0;
  const summary = [];

  await runWithConcurrency(slice, CONCURRENCY, async (code) => {
    try {
      const result = await deleteRoomTypesForProperty(code);
      summary.push(result);
    } catch (err) {
      summary.push({ propertyCode: code, status: 'error', error: err.message });
    } finally {
      done += 1;
      if (done % 20 === 0 || done === slice.length) console.log(`Progress: ${done}/${slice.length}`);
    }
  });

  await mkdir('output', { recursive: true });
  const outFile = `output/delete-batch-${startIndex}-${startIndex + slice.length}.json`;
  await writeFile(outFile, JSON.stringify(summary, null, 2));

  // Master property-code-wise running file across all batches, so there's
  // one place to look regardless of how many batch runs it took.
  const masterFile = 'output/deleted-room-types-by-property.json';
  let master = {};
  try {
    master = JSON.parse(await readFile(masterFile, 'utf8'));
  } catch {
    master = {};
  }
  for (const s of summary) {
    master[s.propertyCode] = {
      status: s.status,
      deletedCount: s.deletedCount ?? 0,
      deletedRecordIds: s.perParent ? s.perParent.flatMap((p) => p.ids) : [],
      error: s.error ?? null,
      timestamp: new Date().toISOString(),
    };
  }
  await writeFile(masterFile, JSON.stringify(master, null, 2));
  console.log(`Master property-wise summary updated: ${masterFile} (${Object.keys(master).length} properties so far)`);

  const totals = summary.reduce(
    (acc, s) => {
      if (s.status === 'error') acc.errors += 1;
      else if (s.status === 'no-property-record') acc.noPropertyRecord += 1;
      else { acc.ok += 1; acc.recordsDeleted += s.deletedCount; }
      return acc;
    },
    { ok: 0, errors: 0, noPropertyRecord: 0, recordsDeleted: 0 }
  );

  console.log('\n--- Batch summary ---');
  console.log(`Properties processed: ${slice.length}`);
  console.log(`OK: ${totals.ok} | No property-data record: ${totals.noPropertyRecord} | Errors: ${totals.errors}`);
  console.log(`Total room-type records deleted: ${totals.recordsDeleted}`);
  console.log(`Full detail: ${outFile}`);

  const errored = summary.filter((s) => s.status === 'error');
  if (errored.length) {
    console.log('\n--- Errors ---');
    for (const e of errored) console.log(`${e.propertyCode}: ${e.error}`);
  }
}

// Guarded so importing deleteRoomTypesForProperty elsewhere (as the retry
// script for the false-negative batch did) doesn't also trigger a full
// default-args batch run as a side effect of the import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
