import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';

// Verifies, per property, that every image actually set in the CMS traces
// back to the EXACT reference-API node the user specified as the source of
// truth for that field - not just "an image exists", but "this specific
// image came from this specific reference field":
//   listing-page-image      <- Data.Results[0].ThumbnailImage.Image.FileName
//   gallery-images (3 tabs) <- Data.Results[0].ImageGallery[].Image.FileName
//   room-images (per room)  <- Data.Results[0].RoomDetails[].ThumbnailImage.Image.FileName
//                              (matched to the CMS room-type record by room-type-code)
//
// A CMS asset's filename is read from OriginalImagePath's last path segment
// (the DAM alias - hyphenated, matches the reference API's own filenames),
// falling back to ResourceFile (display name, spaces) only if that's absent.

const RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const FUZZY_THRESHOLD = 0.6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(name) {
  return (name || '')
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function similarity(a, b) {
  const setA = new Set(normalize(a).split(' ').filter(Boolean));
  const setB = new Set(normalize(b).split(' ').filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  return inter / new Set([...setA, ...setB]).size;
}

// A field that's normally an array (gallery-images, room-images) has been
// observed to come back as the literal STRING "[]" instead of a real empty
// array (seen on RRI1280/RRI1397's Exterior tab) - parse defensively rather
// than assume the shape.
export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function extractFileName(img) {
  if (!img) return null;
  const path = img.OriginalImagePath || img.ThumbNailImagePath || '';
  if (path) return decodeURIComponent(path.split('/').pop().split('?')[0]);
  return img.ResourceFile || null;
}

export function matchAgainst(actualFileName, expectedNames) {
  const candidates = (expectedNames || []).filter(Boolean);
  if (!actualFileName) return { result: 'no-image' };
  const exact = candidates.find((e) => e.toLowerCase() === actualFileName.toLowerCase());
  if (exact) return { result: 'exact', matched: exact };
  let best = null;
  let bestScore = 0;
  for (const e of candidates) {
    const s = similarity(actualFileName, e);
    if (s > bestScore) {
      bestScore = s;
      best = e;
    }
  }
  if (best && bestScore >= FUZZY_THRESHOLD) return { result: 'fuzzy', matched: best, score: bestScore };
  return { result: 'mismatch', closestCandidate: best, score: bestScore };
}

async function fetchCmsRecordsWithRetry(propertyCode) {
  let recs = [];
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    recs = (await getComponentData(propertyCode)).MainFilterObj || [];
    if (recs.length) break;
    if (attempt < RETRIES) await sleep(RETRY_DELAY_MS * attempt);
  }
  return recs;
}

/**
 * Runs the full 3-node accuracy check for one property. Read-only.
 */
export async function verifyProperty(propertyCode) {
  const [cmsRecords, referenceData] = await Promise.all([
    fetchCmsRecordsWithRetry(propertyCode),
    getWebContent([propertyCode]),
  ]);

  if (!cmsRecords.length) return { propertyCode, status: 'no-cms-record' };

  const result0 = referenceData?.Data?.Results?.[0];
  if (!result0) return { propertyCode, status: 'no-reference-data' };

  // A property-code can have >1 property-data record (rare, historically);
  // check every one, same as the rest of this project's plan builders.
  const propertyReports = [];

  for (const pr of cmsRecords) {
    const report = { propertyRecordId: pr.Id, listing: null, gallery: {}, rooms: [] };

    // --- listing-page-image <- ThumbnailImage.Image.FileName ---
    const expectedListingName = result0.ThumbnailImage?.Image?.FileName || null;
    const actualListingImgs = asArray(pr.Data['listing-page-image']);
    const actualListingName = extractFileName(actualListingImgs[0]);
    report.listing = !expectedListingName
      ? { check: 'skipped', reason: 'reference API has no ThumbnailImage.Image.FileName for this property', imageCount: actualListingImgs.length }
      : { expected: expectedListingName, actual: actualListingName, imageCount: actualListingImgs.length, ...matchAgainst(actualListingName, [expectedListingName]) };

    // --- gallery-images (Exterior/Interior/Rooms) <- ImageGallery[].Image.FileName ---
    const expectedGalleryNames = (result0.ImageGallery || []).map((g) => g.Image?.FileName).filter(Boolean);
    const galleryRecords = (pr.ChildRecords || []).filter((r) => r.ComponentAliasName === 'property-level-gallery');
    for (const tab of ['Exterior', 'Interior', 'Rooms']) {
      const rec = galleryRecords.find((g) => (g.Data['gallery-tab-name'] || '').trim().toLowerCase() === tab.toLowerCase());
      const images = rec ? asArray(rec.Data['gallery-images']) : [];
      const checks = images.map((img) => {
        const name = extractFileName(img);
        return { actual: name, ...matchAgainst(name, expectedGalleryNames) };
      });
      report.gallery[tab] = {
        tabExists: !!rec,
        imageCount: images.length,
        checks,
        tracedCount: checks.filter((c) => c.result === 'exact' || c.result === 'fuzzy').length,
        mismatchCount: checks.filter((c) => c.result === 'mismatch').length,
      };
    }

    // --- room-images (per room) <- RoomDetails[].ThumbnailImage.Image.FileName ---
    const roomTypeRecords = (pr.ChildRecords || []).filter((r) => r.ComponentAliasName === 'room-type');
    const referenceRooms = result0.RoomDetails || [];
    for (const rt of roomTypeRecords) {
      const code = rt.Data['room-type-code'];
      const refRoom = referenceRooms.find((r) => (r.RoomType || '').toUpperCase() === (code || '').toUpperCase());
      const images = asArray(rt.Data['room-images']);
      const actualName = extractFileName(images[0]);

      if (!refRoom) {
        report.rooms.push({ roomTypeCode: code, recordId: rt.Id, check: 'no-matching-reference-room', imageCount: images.length });
        continue;
      }
      const expectedName = refRoom.ThumbnailImage?.Image?.FileName || null;
      if (!expectedName) {
        report.rooms.push({ roomTypeCode: code, recordId: rt.Id, check: 'skipped', reason: 'reference room has no ThumbnailImage.Image.FileName', imageCount: images.length });
        continue;
      }
      report.rooms.push({
        roomTypeCode: code, recordId: rt.Id, imageCount: images.length,
        expected: expectedName, actual: actualName,
        ...matchAgainst(actualName, [expectedName]),
      });
    }

    propertyReports.push(report);
  }

  return { propertyCode, status: 'ok', records: propertyReports };
}
