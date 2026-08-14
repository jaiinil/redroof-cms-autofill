import 'dotenv/config';
import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';
import { findPropertyImageAsset } from './clients/damClient.js';
import { deleteComponentRecord } from './clients/miblockDeleteClient.js';
import { createComponentRecord, buildRoomTypeRecordPayload } from './clients/miblockCreateClient.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';
import { loadCreatedRecordIdsForParent } from './createdRegistry.js';

const ROOM_TYPE_MIBLOCK_ID = 20135;
const SITE_ID = 17677;

// Usage: node src/deleteAndRecreateRoomTypes.js <propertyCode>
// Deletes EVERY existing room-type record for this property, then creates
// a fresh one for every room in the reference API (text + single image,
// per the standing one-image-per-room rule). PERMANENT - no undo.
const [, , propertyCode] = process.argv;

if (!propertyCode) {
  console.error('Usage: node src/deleteAndRecreateRoomTypes.js <propertyCode>');
  process.exit(1);
}

async function main() {
  const [cmsData, referenceData] = await Promise.all([
    getComponentData(propertyCode),
    getWebContent([propertyCode]),
  ]);

  const propertyRecords = cmsData.MainFilterObj || [];
  if (!propertyRecords.length) {
    throw new Error(`No CMS property-data record found for ${propertyCode}`);
  }

  const referenceRooms = referenceData?.Data?.Results?.[0]?.RoomDetails || [];
  if (!referenceRooms.length) {
    throw new Error(`No reference-API room data for ${propertyCode} - refusing to delete with nothing to recreate from.`);
  }

  for (const propertyRecord of propertyRecords) {
    const liveRoomTypes = (propertyRecord.ChildRecords || []).filter(
      (r) => r.ComponentAliasName === 'room-type'
    );

    // GetComponentData can lag behind what actually exists (confirmed on
    // RRI207 - a record we created in a prior session didn't show up here,
    // survived a delete pass, and left a stale duplicate). Union the live
    // read with everything action-log.jsonl says we ever created (and
    // haven't since deleted) for this exact parent, so nothing gets missed.
    const liveIds = liveRoomTypes.map((r) => r.Id);
    const loggedIds = await loadCreatedRecordIdsForParent(propertyRecord.Id);
    const allIdsToDelete = [...new Set([...liveIds, ...loggedIds])];

    console.log(`\n=== Property record ${propertyRecord.Id} ===`);
    console.log(`Live room-type records: ${liveRoomTypes.length} | from action-log (may include ones the live read missed): ${loggedIds.length}`);
    console.log(`Total unique record IDs to delete: ${allIdsToDelete.length}`);
    liveRoomTypes.forEach((r) => console.log(`  - ${r.Data['room-type-code']} (RecordId ${r.Id})`));
    loggedIds.filter((id) => !liveIds.includes(id)).forEach((id) => console.log(`  - (from action-log only, not in live read) RecordId ${id}`));

    // --- STEP 1: delete every existing room-type record for this property ---
    if (allIdsToDelete.length) {
      const deleteResult = await deleteComponentRecord({
        miBlockId: ROOM_TYPE_MIBLOCK_ID,
        recordIds: allIdsToDelete,
      });
      console.log('Delete response:', JSON.stringify(deleteResult.body));
    }

    // --- STEP 2: create a fresh record for every reference-API room ---
    for (const refRoom of referenceRooms) {
      const code = refRoom.RoomType;
      const fileName = refRoom.ThumbnailImage?.Image?.FileName
        || (() => { try { return new URL(refRoom.RoomImageImgUrl).pathname.split('/').pop(); } catch { return null; } })();

      const record = buildRoomTypeRecordPayload({
        parentRecordId: propertyRecord.Id,
        miBlockId: ROOM_TYPE_MIBLOCK_ID,
        siteId: SITE_ID,
        roomTypeCode: code,
        roomTypeDescription: refRoom.RoomDescription,
        roomImagesAlt: refRoom.RoomImageAltText,
      });

      const createResult = await createComponentRecord({ componentAliasName: 'Room Type', records: [record] });
      const newRecordId = createResult.body?.componentRecordDetails?.recordsDetails?.[0]?.recordId;
      console.log(code, '-> create:', createResult.body?.Success, 'RecordId:', newRecordId, createResult.body?.ErrorMessage || '');

      if (!createResult.body?.Success || !newRecordId) continue;

      const damMatch = await findPropertyImageAsset(propertyCode, fileName);
      if (!damMatch) {
        console.log(code, '-> no DAM image match for', fileName, '- record created without an image');
        continue;
      }

      const imageResult = await updateMiblockRecordAsset({
        miBlockId: ROOM_TYPE_MIBLOCK_ID,
        recordId: newRecordId,
        assetFields: [{ fieldAlias: 'room-images', assetUrls: [damMatch.asset.assetPath] }],
      });
      console.log(code, '-> image link:', JSON.stringify(imageResult.fieldStatuses));
    }
  }

  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
