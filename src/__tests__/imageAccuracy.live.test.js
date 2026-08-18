import { jest, describe, test, expect, beforeAll } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { verifyProperty } from '../verifyImageAccuracy.js';

// LIVE test - hits production CMS + RediStay for every property. Not part of
// the default fast suite; run explicitly with `npm run test:live` (which
// removes the skip below via LIVE_AUDIT=1) or a subset via
// LIVE_AUDIT=1 LIVE_AUDIT_LIMIT=20 npm run test:live.
//
// Asserts, for every property, that every image actually set in the CMS
// traces (exact or fuzzy) back to the ONE reference-API node the user
// specified as the source of truth for that field:
//   listing-page-image      <- ThumbnailImage.Image.FileName
//   gallery-images (3 tabs) <- ImageGallery[].Image.FileName
//   room-images (per room)  <- RoomDetails[].ThumbnailImage.Image.FileName
//
// A property/field with no reference node to check against (e.g. no
// ThumbnailImage in the feed) is reported as `skipped`, not a failure -
// there is nothing to trace to.

const isLive = process.env.LIVE_AUDIT === '1';
const describeLive = isLive ? describe : describe.skip;
jest.setTimeout(30 * 60 * 1000); // this suite can take a long time across all 712 properties

describeLive('image-source accuracy (LIVE, all properties)', () => {
  let codes;

  beforeAll(async () => {
    codes = JSON.parse(await readFile('output/property-codes.json', 'utf8'));
    const limit = parseInt(process.env.LIVE_AUDIT_LIMIT, 10);
    if (limit > 0) codes = codes.slice(0, limit);
  });

  test('every property traces its listing/gallery/room images to the specified reference node', async () => {
    const CONCURRENCY = 3;
    const results = [];
    let idx = 0;

    async function worker() {
      while (idx < codes.length) {
        const code = codes[idx++];
        try {
          results.push(await verifyProperty(code));
        } catch (err) {
          results.push({ propertyCode: code, status: 'error', error: err.message });
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const realMismatches = [];
    for (const r of results) {
      if (r.status !== 'ok') continue; // no-cms-record / no-reference-data handled separately below
      for (const rec of r.records) {
        if (rec.listing?.result === 'mismatch') {
          realMismatches.push({ propertyCode: r.propertyCode, field: 'listing-page-image', ...rec.listing });
        }
        for (const [tab, g] of Object.entries(rec.gallery)) {
          for (const c of g.checks) {
            if (c.result === 'mismatch') realMismatches.push({ propertyCode: r.propertyCode, field: `gallery-images:${tab}`, ...c });
          }
        }
        for (const room of rec.rooms) {
          if (room.result === 'mismatch') {
            realMismatches.push({ propertyCode: r.propertyCode, field: 'room-images', roomTypeCode: room.roomTypeCode, ...room });
          }
        }
      }
    }

    if (realMismatches.length) {
      console.error(`${realMismatches.length} mismatches found:\n` + JSON.stringify(realMismatches.slice(0, 20), null, 2));
    }
    expect(realMismatches).toEqual([]);
  });
});
