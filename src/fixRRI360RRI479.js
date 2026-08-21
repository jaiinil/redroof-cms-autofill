import 'dotenv/config';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';
import { deleteComponentRecord } from './clients/miblockDeleteClient.js';

async function main() {
  // RRI360: Interior can never shrink below 6 remaining (the 5-asset cap
  // blocks it), so the 3 amenity images (vending/fitness/business) can't be
  // cleanly removed from there. The Amenities record (223812) currently
  // holds those same 3 as a duplicate. Can't clear a field to empty either
  // (same cap-adjacent API limitation) - so DELETE the whole Amenities
  // record instead, same resolution as HTS1298 earlier. Interior keeps all 9
  // images untouched (correct, real photos, just not de-duplicated into a
  // separate tab for now).
  const del = await deleteComponentRecord({ miBlockId: 20133, recordIds: [223812] });
  console.log('RRI360: delete duplicated Amenities record 223812 ->', JSON.stringify(del.body));

  // RRI479: restore the 4 wrongly-classified room photos to Exterior
  // (where they originally were), and separately add the 2 genuine amenity
  // photos (pool, guest laundry) to Amenities (currently empty - the
  // original 6-image create+update failed outright on the cap).
  const exteriorRestored = [
    'https://assets.milestoneinternet.com/red-roof/rri479/siteimages/479-picnic-area.jpg',
    'https://assets.milestoneinternet.com/red-roof/rri479/siteimages/479-exterior.jpg',
    'https://assets.milestoneinternet.com/red-roof/rri479/siteimages/479-superior-king-5.jpg',
    'https://assets.milestoneinternet.com/red-roof/rri479/siteimages/479-vanity-bath-4.jpg',
    'https://assets.milestoneinternet.com/red-roof/rri479/siteimages/479-2-full-beds.jpg',
    'https://assets.milestoneinternet.com/red-roof/rri479/siteimages/479-standard-king.jpg',
  ];
  const r1 = await updateMiblockRecordAsset({
    miBlockId: 20133,
    recordId: 148147,
    assetFields: [{ fieldAlias: 'gallery-images', assetUrls: exteriorRestored }],
  });
  console.log('RRI479: restore 4 room photos to Exterior (6 total, may hit cap) ->', JSON.stringify(r1.fieldStatuses));

  const amenities = [
    'https://assets.milestoneinternet.com/red-roof/rri479/siteimages/479-pool.jpg',
    'https://assets.milestoneinternet.com/red-roof/rri479/siteimages/479-guest-laundry.jpg',
  ];
  const r2 = await updateMiblockRecordAsset({
    miBlockId: 20133,
    recordId: 223852,
    assetFields: [{ fieldAlias: 'gallery-images', assetUrls: amenities }],
  });
  console.log('RRI479: add pool+laundry to Amenities ->', JSON.stringify(r2.fieldStatuses));
}

main().catch((err) => { console.error(err); process.exit(1); });
