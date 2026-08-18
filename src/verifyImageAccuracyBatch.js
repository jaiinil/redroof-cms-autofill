import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyProperty } from './verifyImageAccuracy.js';

const CONCURRENCY = 3;

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

function summarizeProperty(r) {
  if (r.status !== 'ok') return { propertyCode: r.propertyCode, status: r.status };

  let listingOk = 0, listingSkipped = 0, listingMismatch = 0;
  let galleryTraced = 0, galleryMismatch = 0, galleryTotal = 0;
  let roomOk = 0, roomSkipped = 0, roomMismatch = 0, roomNoRef = 0, roomTotal = 0;
  const mismatches = [];

  for (const rec of r.records) {
    if (rec.listing?.result === 'exact' || rec.listing?.result === 'fuzzy') listingOk += 1;
    else if (rec.listing?.check === 'skipped') listingSkipped += 1;
    else if (rec.listing?.result === 'mismatch' || rec.listing?.result === 'no-image') {
      listingMismatch += 1;
      mismatches.push({ field: 'listing-page-image', ...rec.listing });
    }

    for (const [tab, g] of Object.entries(rec.gallery)) {
      galleryTotal += g.imageCount;
      galleryTraced += g.tracedCount;
      galleryMismatch += g.mismatchCount;
      for (const c of g.checks) {
        if (c.result === 'mismatch') mismatches.push({ field: `gallery-images:${tab}`, ...c });
      }
    }

    for (const room of rec.rooms) {
      roomTotal += 1;
      if (room.result === 'exact' || room.result === 'fuzzy') roomOk += 1;
      else if (room.check === 'skipped') roomSkipped += 1;
      else if (room.check === 'no-matching-reference-room') roomNoRef += 1;
      else if (room.result === 'mismatch' || room.result === 'no-image') {
        roomMismatch += 1;
        mismatches.push({ field: 'room-images', roomTypeCode: room.roomTypeCode, ...room });
      }
    }
  }

  return {
    propertyCode: r.propertyCode,
    status: 'ok',
    listing: { ok: listingOk, skipped: listingSkipped, mismatch: listingMismatch },
    gallery: { totalImages: galleryTotal, traced: galleryTraced, mismatch: galleryMismatch },
    rooms: { ok: roomOk, skipped: roomSkipped, noReferenceMatch: roomNoRef, mismatch: roomMismatch, total: roomTotal },
    mismatches,
  };
}

async function main() {
  const [, , startIndexArg, batchSizeArg] = process.argv;
  const startIndex = parseInt(startIndexArg, 10) || 0;
  const batchSize = parseInt(batchSizeArg, 10) || 712;

  const allCodes = JSON.parse(await readFile('output/property-codes.json', 'utf8'));
  const slice = allCodes.slice(startIndex, startIndex + batchSize);
  console.log(`Verifying image-source accuracy for ${slice.length} properties (index ${startIndex} to ${startIndex + slice.length - 1} of ${allCodes.length})`);

  let done = 0;
  const results = [];

  await runWithConcurrency(slice, CONCURRENCY, async (code) => {
    try {
      const r = await verifyProperty(code);
      results.push(summarizeProperty(r));
    } catch (err) {
      results.push({ propertyCode: code, status: 'error', error: err.message });
    } finally {
      done += 1;
      if (done % 25 === 0 || done === slice.length) console.log(`Progress: ${done}/${slice.length}`);
    }
  });

  await mkdir('output', { recursive: true });
  const outFile = `output/image-accuracy-${startIndex}-${startIndex + slice.length}.json`;
  await writeFile(outFile, JSON.stringify(results, null, 2));

  const masterFile = 'output/image-accuracy-by-property.json';
  let master = {};
  try {
    master = JSON.parse(await readFile(masterFile, 'utf8'));
  } catch {
    master = {};
  }
  for (const r of results) master[r.propertyCode] = { ...r, timestamp: new Date().toISOString() };
  await writeFile(masterFile, JSON.stringify(master, null, 2));

  const ok = results.filter((r) => r.status === 'ok');
  const totals = ok.reduce(
    (acc, r) => {
      acc.listingOk += r.listing.ok;
      acc.listingSkipped += r.listing.skipped;
      acc.listingMismatch += r.listing.mismatch;
      acc.galleryTraced += r.gallery.traced;
      acc.galleryMismatch += r.gallery.mismatch;
      acc.galleryTotal += r.gallery.totalImages;
      acc.roomOk += r.rooms.ok;
      acc.roomSkipped += r.rooms.skipped;
      acc.roomNoRef += r.rooms.noReferenceMatch;
      acc.roomMismatch += r.rooms.mismatch;
      acc.roomTotal += r.rooms.total;
      return acc;
    },
    { listingOk: 0, listingSkipped: 0, listingMismatch: 0, galleryTraced: 0, galleryMismatch: 0, galleryTotal: 0, roomOk: 0, roomSkipped: 0, roomNoRef: 0, roomMismatch: 0, roomTotal: 0 }
  );

  console.log('\n--- Accuracy summary ---');
  console.log(`Properties: ${slice.length} | ok: ${ok.length} | problems: ${results.length - ok.length}`);
  console.log(`Listing:  traced=${totals.listingOk}  skipped(no-ref)=${totals.listingSkipped}  MISMATCH=${totals.listingMismatch}`);
  console.log(`Gallery:  images=${totals.galleryTotal}  traced=${totals.galleryTraced}  MISMATCH=${totals.galleryMismatch}`);
  console.log(`Rooms:    total=${totals.roomTotal}  traced=${totals.roomOk}  skipped(no-ref)=${totals.roomSkipped}  no-ref-room=${totals.roomNoRef}  MISMATCH=${totals.roomMismatch}`);
  console.log(`\nDetail: ${outFile}`);
  console.log(`Master: ${masterFile}`);

  const problems = results.filter((r) => r.status !== 'ok');
  if (problems.length) {
    console.log('\n--- Non-ok properties ---');
    for (const p of problems) console.log(`${p.propertyCode}: ${p.status}${p.error ? ' - ' + p.error : ''}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
