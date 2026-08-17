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

  // Source is the reference feed's own ThumbnailImage - the image it nominates
  // as the property's thumbnail - confirmed with the user 2026-08-17, replacing
  // the earlier ImageGallery[0]. Note the two do NOT always agree: on HTS1437
  // ThumbnailImage is a jetted-tub room shot while ImageGallery[0] was the
  // twilight exterior. ImageGallery[0] stays as a fallback so a property with
  // no ThumbnailImage still gets a listing image rather than none.
  const result0 = referenceData?.Data?.Results?.[0];
  const firstGalleryImage = result0?.ThumbnailImage?.Image?.FileName
    ? result0.ThumbnailImage
    : result0?.ImageGallery?.[0];
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
