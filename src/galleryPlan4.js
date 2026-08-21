import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';

export const GALLERY_IMAGE_FIELD_ALIAS = 'gallery-images';
export const GALLERY_MIBLOCK_ID = 20133;
export const MOVE_FROM_CATEGORIES = ['Exterior', 'Interior', 'Rooms'];

// 4-category scheme (client-requested, 2026-08-21, via Vishal): a new
// "Amenities" tab alongside the original Exterior/Interior/Rooms. Client's
// own examples:
//   Exterior  - dedicated pet area, fire pit, EV charging, etc.
//   Interior  - lobby, breakfast area
//   Rooms
//   Amenities - pool, fitness center, business center, vending, laundry,
//               meeting rooms, etc.
// Classification signal is RediStay's GetWebContent reference feed
// (Image.AlternateText + Caption), per explicit instruction to use that API
// - not DAM filenames.
//
// SURGICAL, not a rebuild: galleryPlan.js's original buildGalleryPlan()
// always-refreshes Exterior/Interior/Rooms straight from the reference feed,
// but that feed is a known-thinner subset than the DAM folder (see CLAUDE.md
// rule 4 - it's why damGalleryBatch.js replaced it for ~210 properties, whose
// Exterior tabs the reference feed left empty). Rebuilding those 3 tabs from
// the reference feed here would silently undo that fix. Instead: only move
// OUT images that are CURRENTLY SITTING in Exterior/Interior/Rooms and whose
// reference-feed entry classifies as Amenities - everything else in those
// tabs (including DAM-only images with no reference-feed counterpart) is
// left untouched. Matches the manually-verified RRI1174 pattern.
// Bug found live (2026-08-21, RRI479): a bare `pool` substring matched
// "Poolside" inside ROOM captions ("Superior King Poolside Non-Smoking"),
// wrongly reclassifying 4 room photos as Amenities. \bpool\b requires a word
// boundary on both sides, so "poolside" (one token, no boundary after
// "pool") no longer matches while a real "pool"/"pool." does.
//
// Second bug found immediately after fixing the first one: AlternateText is
// often the raw filename with underscores ("HTS1022_Laundry PRO Approved
// Image") - JS regex treats `_` as a \w character, so \blaundry\b found NO
// boundary between "_" and "l" and silently stopped matching legitimate
// laundry photos too. Normalize underscores/hyphens to spaces before running
// the \b-based keyword checks so both bugs stay fixed together.
function classify(item) {
  const raw = `${item.Image?.AlternateText || ''} ${item.Caption || ''}`.toLowerCase();
  const text = raw.replace(/[_-]+/g, ' ');
  if (text.includes('bath')) return 'Interior';
  if (/\bpool\b|\bfitness\b|\bgym\b|business center|\bvending\b|\blaundry\b|meeting room|\bconference\b/.test(text)) return 'Amenities';
  if (/\bexterior\b|\btwilight\b|\bpatio\b|\bcourtyard\b|\bpicnic\b|dog park|pet area|fire pit|ev charging|\bplayground\b/.test(text)) return 'Exterior';
  if (/\b(king|queen|suite|studio|bed|beds|room)\b/.test(text)) return 'Rooms';
  return 'Interior';
}

// CMS's stored gallery-images ResourceFile/OriginalImagePath use a
// hyphenated, lowercased, no-punctuation form of the reference feed's
// FileName (e.g. reference "1174-Fitness-Center-1-9-20-22.jpg" vs CMS
// "1174-fitness-center-1-9-20-22.jpg" in the URL, "1174-Fitness-Center-1
// (9.20.22).jpg" in ResourceFile) - normalize both sides to compare.
function normalizeFileName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Builds a per-property plan of which currently-placed Exterior/Interior/
 * Rooms images should move to Amenities, based on matching each image's
 * filename against the reference feed's classification.
 */
const EMPTY_RESPONSE_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function buildAmenitiesMovePlan(propertyCode) {
  // GetComponentData has a documented transient-empty-under-load issue
  // (CLAUDE.md: up to ~43% false-negative rate on a concurrent batch) -
  // retry before concluding the property record is genuinely missing. Hit
  // in the first 0-100 pilot run before this retry existed (57/100 false
  // "no property record" errors).
  let cmsData;
  for (let attempt = 1; attempt <= EMPTY_RESPONSE_RETRIES; attempt++) {
    cmsData = await getComponentData(propertyCode);
    if ((cmsData.MainFilterObj || []).length) break;
    if (attempt < EMPTY_RESPONSE_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
  }
  const referenceData = await getWebContent([propertyCode]);

  const propertyRecords = cmsData.MainFilterObj || [];
  if (!propertyRecords.length) {
    throw new Error(`No CMS property-data record found for ${propertyCode}`);
  }

  const galleryItems = referenceData?.Data?.Results?.[0]?.ImageGallery || [];
  const amenityFileNames = new Set(
    galleryItems.filter((item) => classify(item) === 'Amenities').map((item) => normalizeFileName(item.Image?.FileName))
  );

  const plan = [];

  for (const propertyRecord of propertyRecords) {
    const galleryRecords = (propertyRecord.ChildRecords || []).filter(
      (r) => r.ComponentAliasName === 'property-level-gallery'
    );
    const amenitiesRecord = galleryRecords.find((r) => (r.Data['gallery-tab-name'] || '').trim().toLowerCase() === 'amenities');

    const moved = [];

    for (const category of MOVE_FROM_CATEGORIES) {
      const cmsMatch = galleryRecords.find(
        (r) => (r.Data['gallery-tab-name'] || '').trim().toLowerCase() === category.toLowerCase()
      );
      if (!cmsMatch) continue;

      const images = cmsMatch.Data['gallery-images'] || [];
      if (!amenityFileNames.size || !images.length) continue;

      let toMove = images.filter((img) => amenityFileNames.has(normalizeFileName(img.ResourceFile)) || amenityFileNames.has(normalizeFileName(img.OriginalImagePath?.split('/').pop())));
      if (!toMove.length) continue;

      // UpdateMiblockRecordAsset rejects an empty AssetUrls list (see
      // CLAUDE.md's known gaps) - it can never force a field empty. If every
      // image in this tab is amenity-classified, moving all of them would
      // leave 0 remaining and the shrink write would fail while the
      // Amenities write still succeeds, duplicating the image in both places
      // (hit on HTS1298/HTS1284 in the first 0-100 pilot, fixed by hand).
      // Keep the tab non-empty instead: drop the last one back out of the
      // move set so remaining.length is always >= 1.
      if (toMove.length === images.length) toMove = toMove.slice(0, -1);
      if (!toMove.length) continue;

      const remaining = images.filter((img) => !toMove.includes(img));
      moved.push(...toMove.map((img) => ({ url: img.OriginalImagePath, fileName: img.ResourceFile })));
      plan.push({
        propertyCode,
        propertyRecordId: propertyRecord.Id,
        category,
        action: 'shrink-remove-amenities',
        recordId: cmsMatch.Id,
        miBlockId: GALLERY_MIBLOCK_ID,
        fieldAlias: GALLERY_IMAGE_FIELD_ALIAS,
        assetUrls: remaining.map((img) => img.OriginalImagePath),
        removed: toMove.map((img) => img.ResourceFile),
        movedItems: toMove.map((img) => ({ url: img.OriginalImagePath, fileName: img.ResourceFile })),
      });
    }

    if (moved.length) {
      plan.push({
        propertyCode,
        propertyRecordId: propertyRecord.Id,
        category: 'Amenities',
        action: amenitiesRecord ? 'update-image' : 'create-then-update',
        recordId: amenitiesRecord?.Id,
        miBlockId: GALLERY_MIBLOCK_ID,
        fieldAlias: GALLERY_IMAGE_FIELD_ALIAS,
        // Preserve any images already in Amenities (e.g. from an earlier
        // partial run) and append the newly-moved ones, deduped by URL.
        assetUrls: [...new Set([...(amenitiesRecord?.Data['gallery-images'] || []).map((img) => img.OriginalImagePath), ...moved.map((m) => m.url)])],
        moved,
      });
    }
  }

  return { propertyRecords, galleryItems, plan };
}
