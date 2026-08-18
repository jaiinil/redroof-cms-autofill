import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';
import { findPropertyImageAsset, findSharedAsset } from './clients/damClient.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';
import { buildGalleryPlan } from './galleryPlan.js';

const PROPERTY_DATA_MIBLOCK_ID = 20132;
const ROOM_TYPE_MIBLOCK_ID = 20135;

const targets = JSON.parse(await readFile('output/fix-targets.json', 'utf8'));
const results = { listing: [], gallery: [], rooms: [] };

// ============ 1. Listing (RRI1200, RRI296, RRI662) ============
console.log('=== Fixing listing-page-image ===');
for (const code of targets.listingIssues) {
  const [cmsData, refData] = await Promise.all([getComponentData(code), getWebContent([code])]);
  const pr = cmsData.MainFilterObj?.[0];
  const result0 = refData?.Data?.Results?.[0];
  const expected = result0?.ThumbnailImage?.Image?.FileName;
  if (!pr || !expected) { results.listing.push({ code, status: 'no-data' }); continue; }

  let match = await findPropertyImageAsset(code, expected);
  let via = 'property-folder';
  if (!match) {
    const shared = await findSharedAsset(expected);
    if (shared) { match = { asset: shared, matchType: 'exact' }; via = 'shared-placeholder'; }
  }
  if (!match) { results.listing.push({ code, status: 'no-dam-match', expected }); continue; }

  const r = await updateMiblockRecordAsset({
    miBlockId: PROPERTY_DATA_MIBLOCK_ID,
    recordId: pr.Id,
    assetFields: [{ fieldAlias: 'listing-page-image', assetUrls: [match.asset.assetPath] }],
  });
  const ok = (r.fieldStatuses || []).every((f) => f.Success !== false);
  results.listing.push({ code, status: ok ? 'fixed' : 'update-failed', via, matchType: match.matchType, assetPath: match.asset.assetPath });
  console.log(code, '->', ok ? 'fixed' : 'FAILED', `(${via}, ${match.matchType})`);
}

// ============ 2. Gallery - strictly rebuilt from ImageGallery[] ============
console.log('\n=== Fixing property-level-gallery (strict reference-only rebuild) ===');
for (const code of targets.galleryProps) {
  try {
    const { plan } = await buildGalleryPlan(code);
    const tabResults = [];
    for (const p of plan) {
      if (p.action !== 'update-image') { tabResults.push({ tab: p.category, action: p.action }); continue; }
      const r = await updateMiblockRecordAsset({
        miBlockId: p.miBlockId,
        recordId: p.recordId,
        assetFields: [{ fieldAlias: p.fieldAlias, assetUrls: p.assetUrls }],
      });
      const ok = (r.fieldStatuses || []).every((f) => f.Success !== false);
      tabResults.push({ tab: p.category, action: 'updated', count: p.assetUrls.length, ok });
    }
    results.gallery.push({ code, status: 'ok', tabs: tabResults });
    console.log(code, '->', tabResults.map((t) => `${t.tab}:${t.action === 'updated' ? t.count : t.action}`).join(' '));
  } catch (err) {
    results.gallery.push({ code, status: 'error', error: err.message });
    console.log(code, '-> ERROR', err.message);
  }
}

// ============ 3. Room images with no image set (incl. shared-placeholder fallback) ============
console.log('\n=== Fixing room-images (no-image cases) ===');
const roomsByProperty = {};
for (const r of targets.roomIssues) {
  (roomsByProperty[r.code] ||= []).push(r);
}
for (const [code, rooms] of Object.entries(roomsByProperty)) {
  for (const room of rooms) {
    let match = await findPropertyImageAsset(code, room.expected);
    let via = 'property-folder';
    if (!match) {
      const shared = await findSharedAsset(room.expected);
      if (shared) { match = { asset: shared, matchType: 'exact' }; via = 'shared-placeholder'; }
    }
    if (!match) {
      results.rooms.push({ code, roomTypeCode: room.roomTypeCode, status: 'still-no-dam-match', expected: room.expected });
      console.log(code, room.roomTypeCode, '-> still no DAM match for', room.expected);
      continue;
    }

    // Need the CMS recordId for this room-type record
    const cmsData = await getComponentData(code);
    const pr = cmsData.MainFilterObj?.[0];
    const rt = (pr?.ChildRecords || []).find((c) => c.ComponentAliasName === 'room-type' && c.Data['room-type-code'] === room.roomTypeCode);
    if (!rt) {
      results.rooms.push({ code, roomTypeCode: room.roomTypeCode, status: 'no-cms-record' });
      continue;
    }
    const r = await updateMiblockRecordAsset({
      miBlockId: ROOM_TYPE_MIBLOCK_ID,
      recordId: rt.Id,
      assetFields: [{ fieldAlias: 'room-images', assetUrls: [match.asset.assetPath] }],
    });
    const ok = (r.fieldStatuses || []).every((f) => f.Success !== false);
    results.rooms.push({ code, roomTypeCode: room.roomTypeCode, status: ok ? 'fixed' : 'update-failed', via, matchType: match.matchType });
    console.log(code, room.roomTypeCode, '->', ok ? 'fixed' : 'FAILED', `(${via})`);
  }
}

await writeFile('output/fix-accuracy-issues-result.json', JSON.stringify(results, null, 2));

console.log('\n=== Summary ===');
console.log('Listing:', results.listing.filter((r) => r.status === 'fixed').length, '/', results.listing.length, 'fixed');
console.log('Gallery:', results.gallery.filter((r) => r.status === 'ok').length, '/', results.gallery.length, 'properties processed');
console.log('Rooms:', results.rooms.filter((r) => r.status === 'fixed').length, '/', results.rooms.length, 'fixed');
