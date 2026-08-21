import 'dotenv/config';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';
import { deleteComponentRecord } from './clients/miblockDeleteClient.js';

// One-off remediation (2026-08-21): the amenitiesGalleryBatch.js 0-100 pilot
// hit an unhandled edge case - moving the ONLY amenity-classified image out
// of a tab would leave it with 0 images, and UpdateMiblockRecordAsset can
// never accept an empty AssetUrls list, so the "shrink" write failed while
// the "add to Amenities" write succeeded independently. Net effect: the
// image ended up duplicated in both its original tab and Amenities. Exactly
// 2 of the 100-property pilot hit this (HTS1298, HTS1284) - fixing both by
// hand before the code fix (galleryPlan4.js: skip a move that would empty
// its source tab) goes into the batch script itself.

async function main() {
  // HTS1298: Amenities record (223536) has only the duplicated Pool photo -
  // nothing legitimately belongs there, so delete the record outright and
  // leave Exterior (165299) untouched (still correctly has Pool).
  const del = await deleteComponentRecord({ miBlockId: 20133, recordIds: [223536] });
  console.log('HTS1298: delete Amenities record 223536 ->', JSON.stringify(del));

  // HTS1284: Amenities record (223537) has 14 images, 6 of which are
  // duplicates of images that are STILL in Exterior/Rooms (those shrinks
  // failed). Strip the 6 duplicates, keep the 8 that came cleanly from
  // Interior (whose shrink succeeded).
  const keep = [
    'https://assets.milestoneinternet.com/red-roof/hts1284/siteimages/hts1284-fitness-center-1-pro-approved-7-26-24.jpg',
    'https://assets.milestoneinternet.com/red-roof/hts1284/siteimages/hts1284-business-center-pro-approved-7-26-24.jpg',
    'https://assets.milestoneinternet.com/red-roof/hts1284/siteimages/hts1284-front-desk-3-pro-approved-7-26-24.jpg',
    'https://assets.milestoneinternet.com/red-roof/hts1284/siteimages/hts1284-lobby-4-pro-approved-7-26-24.jpg',
    'https://assets.milestoneinternet.com/red-roof/hts1284/siteimages/hts1284-laundry-pro-approved-7-26-24.jpg',
    'https://assets.milestoneinternet.com/red-roof/hts1284/siteimages/ballroom-hts1284-hometowne-studios-conference-center-cortland-temp-approved-1.jpeg',
    'https://assets.milestoneinternet.com/red-roof/hts1284/siteimages/hts1284-twilight-1-pro-approved-7-26-24.jpg',
    'https://assets.milestoneinternet.com/red-roof/hts1284/siteimages/hts1284-market-pro-approved-7-26-24.jpg',
  ];
  const upd = await updateMiblockRecordAsset({
    miBlockId: 20133,
    recordId: 223537,
    assetFields: [{ fieldAlias: 'gallery-images', assetUrls: keep }],
  });
  console.log('HTS1284: strip 6 duplicates from Amenities 223537 ->', JSON.stringify(upd.fieldStatuses));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
