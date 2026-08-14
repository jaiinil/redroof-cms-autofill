import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';
import { findPropertyImageAsset } from './clients/damClient.js';
import { recordNoMatch } from './noMatchLog.js';

export const LISTING_IMAGE_FIELD_ALIAS = 'listing-page-image';
export const PROPERTY_DATA_MIBLOCK_ID = 20132;

/**
 * Builds the listing-page-image update for a property. Unlike room-images,
 * this field is always refreshed (not skipped when already populated) -
 * source is always ImageGallery[0] from the reference API, matched to a
 * single DAM asset in the property's folder. Read-only until the caller
 * applies it via updateMiblockRecordAsset.
 */
export async function buildListingImagePlan(propertyCode) {
  const [cmsData, referenceData] = await Promise.all([
    getComponentData(propertyCode),
    getWebContent([propertyCode]),
  ]);

  const propertyRecords = cmsData.MainFilterObj || [];
  if (!propertyRecords.length) {
    throw new Error(`No CMS property-data record found for ${propertyCode}`);
  }

  const firstGalleryImage = referenceData?.Data?.Results?.[0]?.ImageGallery?.[0];
  if (!firstGalleryImage) {
    await recordNoMatch({ propertyCode, component: 'listing-page-image', identifier: 'listing-page-image', fileName: null, reason: 'no ImageGallery entries in reference API' });
    return propertyRecords.map((pr) => ({
      propertyCode,
      propertyRecordId: pr.Id,
      action: 'skip-no-reference-image',
      reason: 'Reference API returned no ImageGallery entries for this property.',
    }));
  }

  const fileName = firstGalleryImage.Image.FileName;
  const damMatch = await findPropertyImageAsset(propertyCode, fileName);
  if (!damMatch) {
    await recordNoMatch({ propertyCode, component: 'listing-page-image', identifier: 'listing-page-image', fileName, reason: 'no DAM match' });
  }

  return propertyRecords.map((pr) => ({
    propertyCode,
    propertyRecordId: pr.Id,
    action: damMatch ? 'update-image' : 'skip-no-dam-image-match',
    fieldAlias: LISTING_IMAGE_FIELD_ALIAS,
    miBlockId: PROPERTY_DATA_MIBLOCK_ID,
    recordId: pr.Id,
    damLookupFileName: fileName,
    damImage: damMatch
      ? { assetPath: damMatch.asset.assetPath, matchType: damMatch.matchType, score: damMatch.score }
      : null,
  }));
}
