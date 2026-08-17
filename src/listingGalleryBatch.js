import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildListingImagePlan } from './listingImagePlan.js';
import { buildGalleryPlan } from './galleryPlan.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';

const CONCURRENCY = 3;
const EMPTY_RESPONSE_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// The CMS caps gallery-images at 5 assets per field. Sending more fails the
// FIELD ("Number of AssetUrls exceeds the maximum limit of 5 for field alias
// gallery-images") while the top-level Success stays true - so the whole tab
// silently ends up empty. 170 tabs across 159 properties were lost this way
// on the first run. Truncate, and report what was dropped.
const MAX_GALLERY_IMAGES = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Applies listing-page-image and property-level-gallery for one property.
 *
 * Both fields are "always refresh" (standing rule 2) - unlike room-images
 * there is no skip-if-populated and no delete/create, so this is update-only
 * and carries none of the permanence risk the room-type rollout does.
 *
 * The plan builders throw when GetComponentData returns no property record,
 * which under load is usually the documented transient-empty-response issue
 * rather than a genuinely missing property - so that specific failure is
 * retried before being reported.
 */
export async function applyListingAndGalleryForProperty(propertyCode) {
  const result = { propertyCode, status: 'ok', listing: [], gallery: [], unmatched: [] };

  // --- listing-page-image ---
  let listingPlan = null;
  for (let attempt = 1; attempt <= EMPTY_RESPONSE_RETRIES; attempt++) {
    try {
      listingPlan = await buildListingImagePlan(propertyCode);
      break;
    } catch (err) {
      if (!/No CMS property-data record found/.test(err.message)) throw err;
      if (attempt === EMPTY_RESPONSE_RETRIES) return { propertyCode, status: 'no-property-record' };
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  for (const p of listingPlan) {
    if (p.action !== 'update-image') {
      result.listing.push({ recordId: p.propertyRecordId, result: 'skip:' + p.action, fileName: p.damLookupFileName });
      continue;
    }
    const r = await updateMiblockRecordAsset({
      miBlockId: p.miBlockId,
      recordId: p.recordId,
      assetFields: [{ fieldAlias: p.fieldAlias, assetUrls: [p.damImage.assetPath] }],
    });
    const ok = (r.fieldStatuses || []).every((f) => f.Success !== false) && !r.missingAliases.length;
    result.listing.push({ recordId: p.recordId, result: ok ? 'ok' : 'check', asset: p.damImage.assetPath });
  }

  // --- property-level-gallery ---
  const { plan: galleryPlan } = await buildGalleryPlan(propertyCode);
  for (const p of galleryPlan) {
    if (p.action === 'unmatched-reference-images') {
      result.unmatched.push(...p.unmatched);
      continue;
    }
    if (p.action !== 'update-image') {
      result.gallery.push({ category: p.category, result: 'skip:' + p.action });
      continue;
    }
    const assetUrls = p.assetUrls.slice(0, MAX_GALLERY_IMAGES);
    const dropped = p.assetUrls.length - assetUrls.length;
    const r = await updateMiblockRecordAsset({
      miBlockId: p.miBlockId,
      recordId: p.recordId,
      assetFields: [{ fieldAlias: p.fieldAlias, assetUrls }],
    });
    const ok = (r.fieldStatuses || []).every((f) => f.Success !== false) && !r.missingAliases.length;
    const entry = { category: p.category, recordId: p.recordId, images: assetUrls.length, result: ok ? 'ok' : 'check' };
    if (dropped) {
      entry.droppedOverLimit = dropped;
      entry.droppedFiles = p.assetUrls.slice(MAX_GALLERY_IMAGES).map((u) => u.split('/').pop());
    }
    if (!ok) entry.fieldStatuses = r.fieldStatuses;
    result.gallery.push(entry);
  }

  return result;
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
  console.log(`Listing + gallery for ${slice.length} properties (index ${startIndex} to ${startIndex + slice.length - 1} of ${allCodes.length})`);

  let done = 0;
  const summary = [];

  await runWithConcurrency(slice, CONCURRENCY, async (code) => {
    try {
      summary.push(await applyListingAndGalleryForProperty(code));
    } catch (err) {
      summary.push({ propertyCode: code, status: 'error', error: err.message });
    } finally {
      done += 1;
      if (done % 20 === 0 || done === slice.length) console.log(`Progress: ${done}/${slice.length}`);
    }
  });

  await mkdir('output', { recursive: true });
  const outFile = `output/listing-gallery-batch-${startIndex}-${startIndex + slice.length}.json`;
  await writeFile(outFile, JSON.stringify(summary, null, 2));

  const masterFile = 'output/listing-gallery-by-property.json';
  let master = {};
  try {
    master = JSON.parse(await readFile(masterFile, 'utf8'));
  } catch {
    master = {};
  }
  for (const s of summary) master[s.propertyCode] = { ...s, timestamp: new Date().toISOString() };
  await writeFile(masterFile, JSON.stringify(master, null, 2));

  const totals = summary.reduce(
    (acc, s) => {
      if (s.status === 'error') acc.errors += 1;
      else if (s.status === 'no-property-record') acc.noPropertyRecord += 1;
      else {
        acc.ok += 1;
        acc.listingUpdated += (s.listing || []).filter((l) => l.result === 'ok').length;
        acc.listingSkipped += (s.listing || []).filter((l) => String(l.result).startsWith('skip')).length;
        acc.galleryTabs += (s.gallery || []).filter((g) => g.result === 'ok').length;
        acc.galleryImages += (s.gallery || []).filter((g) => g.result === 'ok').reduce((n, g) => n + g.images, 0);
        acc.unmatched += (s.unmatched || []).length;
      }
      return acc;
    },
    { ok: 0, errors: 0, noPropertyRecord: 0, listingUpdated: 0, listingSkipped: 0, galleryTabs: 0, galleryImages: 0, unmatched: 0 }
  );

  console.log('\n--- Batch summary ---');
  console.log(`Properties: ${slice.length} | OK: ${totals.ok} | No property record: ${totals.noPropertyRecord} | Errors: ${totals.errors}`);
  console.log(`Listing images set: ${totals.listingUpdated} | skipped (no ref/DAM match): ${totals.listingSkipped}`);
  console.log(`Gallery tabs filled: ${totals.galleryTabs} | gallery images linked: ${totals.galleryImages}`);
  console.log(`Reference images with no DAM match: ${totals.unmatched}`);
  console.log(`Detail: ${outFile}`);
  console.log(`Master file updated: ${masterFile} (${Object.keys(master).length} properties tracked)`);

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
