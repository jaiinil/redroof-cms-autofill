import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';
import { findPropertyImageAsset } from './clients/damClient.js';
import { recordNoMatch } from './noMatchLog.js';

export const GALLERY_IMAGE_FIELD_ALIAS = 'gallery-images';
export const GALLERY_MIBLOCK_ID = 20133;
const CATEGORIES = ['Exterior', 'Interior', 'Rooms'];

// Bathroom photos often carry a room-name keyword (e.g. "Superior King
// Bathroom Image") which would otherwise misclassify them as Rooms -
// treated as Interior per prior confirmed decision.
function classify(item) {
  const text = `${item.Image?.AlternateText || ''} ${item.Caption || ''}`.toLowerCase();
  if (text.includes('bath')) return 'Interior';
  // "exterior" alone missed a lot: twilight shots, pool, patio, dog park and
  // picnic areas are all outdoors and were landing in Interior.
  if (/exterior|twilight|pool|patio|courtyard|picnic|dog park|playground/.test(text)) return 'Exterior';
  if (/\b(king|queen|suite|studio|bed|beds|room)\b/.test(text)) return 'Rooms';
  return 'Interior';
}

/**
 * Builds the property-level-gallery update for a property (Exterior /
 * Interior / Rooms tabs). Always refreshed (not skipped when already
 * populated) - every reference-API ImageGallery entry is categorized and
 * DAM-matched individually (each is a distinct, explicitly-referenced photo,
 * unlike room-images which takes exactly one URL per room).
 */
export async function buildGalleryPlan(propertyCode) {
  const [cmsData, referenceData] = await Promise.all([
    getComponentData(propertyCode),
    getWebContent([propertyCode]),
  ]);

  const propertyRecords = cmsData.MainFilterObj || [];
  if (!propertyRecords.length) {
    throw new Error(`No CMS property-data record found for ${propertyCode}`);
  }

  const galleryItems = referenceData?.Data?.Results?.[0]?.ImageGallery || [];

  const plan = [];

  for (const propertyRecord of propertyRecords) {
    const galleryRecords = (propertyRecord.ChildRecords || []).filter(
      (r) => r.ComponentAliasName === 'property-level-gallery'
    );

    const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
    const unmatched = [];

    for (const item of galleryItems) {
      const category = classify(item);
      const damMatch = await findPropertyImageAsset(propertyCode, item.Image?.FileName);
      if (damMatch) {
        byCategory[category].push({ assetPath: damMatch.asset.assetPath, matchType: damMatch.matchType, score: damMatch.score });
      } else {
        unmatched.push({ fileName: item.Image?.FileName, category });
        await recordNoMatch({ propertyCode, component: 'gallery-images', identifier: category, fileName: item.Image?.FileName, reason: 'no DAM match' });
      }
    }

    for (const category of CATEGORIES) {
      const cmsMatch = galleryRecords.find(
        (r) => (r.Data['gallery-tab-name'] || '').trim().toLowerCase() === category.toLowerCase()
      );
      const base = { propertyCode, propertyRecordId: propertyRecord.Id, category };

      if (!cmsMatch) {
        plan.push({ ...base, action: 'skip-no-cms-record', reason: `No property-level-gallery record with tab "${category}".` });
        continue;
      }

      const images = byCategory[category];
      plan.push({
        ...base,
        recordId: cmsMatch.Id,
        miBlockId: GALLERY_MIBLOCK_ID,
        action: images.length ? 'update-image' : 'skip-no-images-for-category',
        fieldAlias: GALLERY_IMAGE_FIELD_ALIAS,
        assetUrls: images.map((i) => i.assetPath),
        images,
      });
    }

    if (unmatched.length) {
      plan.push({ propertyCode, propertyRecordId: propertyRecord.Id, action: 'unmatched-reference-images', unmatched });
    }
  }

  return { propertyRecords, galleryItems, plan };
}
