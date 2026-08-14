import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';
import { findPropertyImageAsset } from './clients/damClient.js';
import { loadCreatedRegistry } from './createdRegistry.js';
import { recordNoMatch } from './noMatchLog.js';

export const ROOM_IMAGE_FIELD_ALIAS = 'room-images';
export const ROOM_IMAGE_ALT_FIELD_ALIAS = 'room-images-alt';

function imageFileNameFor(refRoom) {
  const fromThumbnail = refRoom.ThumbnailImage?.Image?.FileName;
  if (fromThumbnail) return fromThumbnail;
  try {
    return new URL(refRoom.RoomImageImgUrl).pathname.split('/').pop();
  } catch {
    return null;
  }
}

/**
 * Builds an update/create plan for one property code. Read-only - makes no
 * writes (the DAM lookup is a search call, also read-only). A single
 * property code can legitimately map to multiple CMS property-data records
 * (distinct index/profile entries); all are processed.
 *
 * GetComponentData has been observed to lag behind CMS admin for records we
 * just created (root cause unconfirmed) - so "no CMS record found" is cross
 * checked against our own createdRegistry (built from action-log.jsonl)
 * before concluding a room-type genuinely needs creating, to avoid
 * duplicate-creating something we already made moments ago.
 */
export async function buildPlanForProperty(propertyCode) {
  const [cmsData, referenceData, createdRegistry] = await Promise.all([
    getComponentData(propertyCode),
    getWebContent([propertyCode]),
    loadCreatedRegistry(),
  ]);

  const propertyRecords = cmsData.MainFilterObj || [];
  if (!propertyRecords.length) {
    throw new Error(`No CMS property-data record found for ${propertyCode}`);
  }

  const referenceRooms = referenceData?.Data?.Results?.[0]?.RoomDetails || [];

  const plan = [];

  for (const propertyRecord of propertyRecords) {
    const cmsRoomTypes = (propertyRecord.ChildRecords || []).filter(
      (r) => r.ComponentAliasName === 'room-type'
    );

    for (const refRoom of referenceRooms) {
      const code = refRoom.RoomType;
      const cmsMatch = cmsRoomTypes.find(
        (r) => (r.Data['room-type-code'] || '').toUpperCase() === (code || '').toUpperCase()
      );
      const existingImageCount = cmsMatch ? (cmsMatch.Data[ROOM_IMAGE_FIELD_ALIAS] || []).length : 0;

      const base = { propertyCode, propertyRecordId: propertyRecord.Id, roomTypeCode: code };

      if (!cmsMatch) {
        const registryKey = `${propertyRecord.Id}|${(code || '').toUpperCase()}`;
        if (createdRegistry.has(registryKey)) {
          plan.push({
            ...base,
            action: 'skip-already-created-pending-index',
            reason: 'Already created in a previous run (per action-log.jsonl); GetComponentData has not reflected it yet.',
          });
          continue;
        }

        const fileName = imageFileNameFor(refRoom);
        const damMatch = await findPropertyImageAsset(propertyCode, fileName);
        if (!damMatch) {
          await recordNoMatch({ propertyCode, component: 'room-images', identifier: code, fileName, reason: 'no DAM match (new room-type record)' });
        }

        plan.push({
          ...base,
          action: 'create',
          miBlockId: cmsRoomTypes[0]?.ComponentId ?? null, // room-type MiBlockId is shared; null only if property has zero room-type records to sample from
          roomTypeDescription: refRoom.RoomDescription,
          roomImagesAlt: refRoom.RoomImageAltText,
          damImage: damMatch
            ? { assetPath: damMatch.asset.assetPath, matchType: damMatch.matchType, score: damMatch.score }
            : null,
          damLookupFileName: fileName,
        });
        continue;
      }

      if (existingImageCount > 0) {
        plan.push({
          ...base,
          recordId: cmsMatch.Id,
          miBlockId: cmsMatch.ComponentId,
          action: 'skip-already-has-image',
          existingImageCount,
        });
        continue;
      }

      const fileName = imageFileNameFor(refRoom);
      const damMatch = await findPropertyImageAsset(propertyCode, fileName);
      if (!damMatch) {
        await recordNoMatch({ propertyCode, component: 'room-images', identifier: code, fileName, reason: 'no DAM match (existing empty room-type record)' });
      }

      plan.push({
        ...base,
        recordId: cmsMatch.Id,
        miBlockId: cmsMatch.ComponentId,
        action: damMatch ? 'update-image' : 'skip-no-dam-image-match',
        fieldAlias: ROOM_IMAGE_FIELD_ALIAS,
        damImage: damMatch
          ? { assetPath: damMatch.asset.assetPath, matchType: damMatch.matchType, score: damMatch.score }
          : null,
        damLookupFileName: fileName,
      });
    }
  }

  return { propertyRecords, referenceRooms, plan };
}
