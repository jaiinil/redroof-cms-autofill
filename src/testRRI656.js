import 'dotenv/config';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';
import { createComponentRecord, buildRoomTypeRecordPayload } from './clients/miblockCreateClient.js';

const DAM = 'https://assets.milestoneinternet.com/red-roof/rri656/siteimages';
const PROPERTY_MIBLOCK_ID = 20132;
const GALLERY_MIBLOCK_ID = 20133;
const ROOM_TYPE_MIBLOCK_ID = 20135;
const PROPERTY_DATA_RECORD_ID = 148546;
const SITE_ID = 17677;

async function main() {
  console.log('=== 1. listing-page-image ===');
  const listingResult = await updateMiblockRecordAsset({
    miBlockId: PROPERTY_MIBLOCK_ID,
    recordId: PROPERTY_DATA_RECORD_ID,
    assetFields: [{ fieldAlias: 'listing-page-image', assetUrls: [`${DAM}/656-deluxe-2-queen-beds.jpg`] }],
  });
  console.log(JSON.stringify(listingResult.fieldStatuses, null, 2));

  console.log('=== 2. property-level-gallery ===');
  const galleryPlan = [
    { recordId: 148547, label: 'Exterior', images: ['656-exterior.jpg'] },
    { recordId: 148548, label: 'Interior', images: ['656-lobby.jpg', '656-guest-laundry.jpg', '656-vending-c.jpg', '656-vanity-bath.jpg'] },
    { recordId: 148549, label: 'Rooms', images: ['656-superior-king.jpg', '656-2-queen-beds-2.jpg', '656-1-queen-bed.jpg'] },
  ];
  for (const g of galleryPlan) {
    const result = await updateMiblockRecordAsset({
      miBlockId: GALLERY_MIBLOCK_ID,
      recordId: g.recordId,
      assetFields: [{ fieldAlias: 'gallery-images', assetUrls: g.images.map((f) => `${DAM}/${f}`) }],
    });
    console.log(g.label, JSON.stringify(result.fieldStatuses));
  }

  console.log('=== 3. room-type creates ===');
  const missingRooms = [
    { code: 'ND2QM', description: 'Deluxe 2 Queen Beds Non-Smoking Image', altText: 'Deluxe 2 Queen Beds Non-Smoking Image', image: '656-deluxe-2-queen-beds.jpg' },
    { code: 'ND1QM', description: 'Deluxe Queen Non-Smoking Image', altText: 'Deluxe Queen Non-Smoking Image', image: '656-1-queen-bed.jpg' },
    { code: 'NT1KJ', description: 'Suite 1 Kind Bed with Jetted Tub Non-Smoking Image', altText: 'Suite 1 Kind Bed with Jetted Tub Non-Smoking Image', image: '656-standard-queen-2.jpg' },
    { code: 'NAD1QR', description: 'ADA Accessible Deluxe Queen with Roll-In Shower Non-Smoking Image', altText: 'ADA Accessible Deluxe Queen with Roll-In Shower Non-Smoking Image', image: '656-ada-standard-queen-2.jpg' },
  ];

  for (const room of missingRooms) {
    const record = buildRoomTypeRecordPayload({
      parentRecordId: PROPERTY_DATA_RECORD_ID,
      miBlockId: ROOM_TYPE_MIBLOCK_ID,
      siteId: SITE_ID,
      roomTypeCode: room.code,
      roomTypeDescription: room.description,
      roomImagesAlt: room.altText,
    });

    const createResult = await createComponentRecord({ componentAliasName: 'Room Type', records: [record] });
    const newRecordId = createResult.body?.componentRecordDetails?.recordsDetails?.[0]?.recordId;
    console.log(room.code, '-> create:', createResult.body?.Success, 'RecordId:', newRecordId);

    if (createResult.body?.Success && newRecordId) {
      const imageResult = await updateMiblockRecordAsset({
        miBlockId: ROOM_TYPE_MIBLOCK_ID,
        recordId: newRecordId,
        assetFields: [{ fieldAlias: 'room-images', assetUrls: [`${DAM}/${room.image}`] }],
      });
      console.log(room.code, '-> image link:', JSON.stringify(imageResult.fieldStatuses));
    }
  }

  console.log('=== Done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
