import 'dotenv/config';
import { getComponentData } from './clients/cmsClient.js';
import { getProfileIdForPropertyCode } from './clients/profileClient.js';
import { createComponentRecord } from './clients/miblockCreateClient.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';

// One-off test (2026-08-21): client added a 4th property-level-gallery
// category ("Amenities" - pool, fitness center, business center, vending,
// laundry, meeting rooms) alongside Exterior/Interior/Rooms. RRI1174 already
// has real DAM/reference photos for two of these (Pool, Fitness Center) that
// are currently misfiled under Exterior and Interior respectively - this is
// the first real reclassification test: create the Amenities tab, move those
// two photos into it, and update the tabs they came from.

const GALLERY_MIBLOCK_ID = 20133;
const PROPERTY_DATA_MIBLOCK_ID = 20132;
const SITE_ID = 17677;
const PROPERTY_CODE = 'RRI1174';

const POOL_URL = 'https://assets.milestoneinternet.com/red-roof/rri1174/siteimages/1174-pool-1-9-20-22.jpg';
const FITNESS_URL = 'https://assets.milestoneinternet.com/red-roof/rri1174/siteimages/1174-fitness-center-1-9-20-22.jpg';
const EXTERIOR_NIGHT_URL = 'https://assets.milestoneinternet.com/red-roof/rri1174/siteimages/1174-exterior-night-1-9-21-22.jpg';
const LOBBY_1_URL = 'https://assets.milestoneinternet.com/red-roof/rri1174/siteimages/1174-lobby-1-9-20-22.jpg';
const LOBBY_6_URL = 'https://assets.milestoneinternet.com/red-roof/rri1174/siteimages/1174-lobby-6-9-20-22.jpg';

async function main() {
  const cms = await getComponentData(PROPERTY_CODE);
  const pr = cms.MainFilterObj?.[0];
  if (!pr) throw new Error(`No property-data record found for ${PROPERTY_CODE}`);

  const galleries = (pr.ChildRecords || []).filter((c) => c.ComponentAliasName === 'property-level-gallery');
  const exterior = galleries.find((g) => (g.Data['gallery-tab-name'] || '').trim() === 'Exterior');
  const interior = galleries.find((g) => (g.Data['gallery-tab-name'] || '').trim() === 'Interior');
  if (!exterior || !interior) throw new Error('Exterior/Interior tab record not found');

  const profileId = await getProfileIdForPropertyCode(PROPERTY_CODE);
  if (!profileId) throw new Error(`No ProfileId found for ${PROPERTY_CODE}`);

  // 1. Create the Amenities tab record.
  const data = {
    ProfileCouponMapping: '',
    ComponentLevel: '5',
    displayName: 'Property-Level-Gallery',
    Offset: '+00:00',
    ComponentName: 'Property-Level-Gallery',
    RecordText: '',
    PluginName: '',
    PrimaryLanguageRecordId: '0',
    UrlLanguageCode: '',
    LanguageId: '0',
    IsAdditionalMappingAllowed: 'False',
    'gallery-tab-name': 'Amenities',
    EnableClientEdit: true,
    IsRecordIncludedInTranslation: false,
    IsLanguageRecordInEnglish: false,
    IsProtected: 'false',
    IsMemberRoleTaggingEnable: 'false',
  };
  const record = {
    RecordId: 0,
    Id: 0,
    CmpId: GALLERY_MIBLOCK_ID,
    ComponentId: GALLERY_MIBLOCK_ID,
    ParentRecordId: pr.Id,
    SiteId: SITE_ID,
    ComponentName: 'Property-Level-Gallery',
    ComponentAliasName: 'property-level-gallery',
    Status: true,
    IsPlaceholderRecord: false,
    SelectedProfiles: String(profileId),
    PreviousAssignProfileIds: String(profileId),
    MainParentComponentId: String(PROPERTY_DATA_MIBLOCK_ID),
    ParentComponentId: String(PROPERTY_DATA_MIBLOCK_ID),
    RecordJsonString: JSON.stringify(data),
  };
  const createResult = await createComponentRecord({ componentAliasName: 'Property-Level-Gallery', records: [record] });
  const newRecordId = createResult.body?.componentRecordDetails?.recordsDetails?.[0]?.recordId;
  console.log('1. Create Amenities record -> Success:', createResult.body?.Success, '| RecordId:', newRecordId, '|', createResult.body?.ErrorMessage);
  if (!createResult.body?.Success || !newRecordId) throw new Error('Amenities record create failed, stopping');

  // 2. Amenities tab <- Pool + Fitness Center.
  const r2 = await updateMiblockRecordAsset({
    miBlockId: GALLERY_MIBLOCK_ID,
    recordId: newRecordId,
    assetFields: [{ fieldAlias: 'gallery-images', assetUrls: [POOL_URL, FITNESS_URL] }],
  });
  console.log('2. Amenities <- Pool+Fitness -> fieldStatuses:', JSON.stringify(r2.fieldStatuses));

  // 3. Exterior tab <- Exterior-Night only (Pool removed).
  const r3 = await updateMiblockRecordAsset({
    miBlockId: GALLERY_MIBLOCK_ID,
    recordId: exterior.Id,
    assetFields: [{ fieldAlias: 'gallery-images', assetUrls: [EXTERIOR_NIGHT_URL] }],
  });
  console.log('3. Exterior <- Exterior-Night only -> fieldStatuses:', JSON.stringify(r3.fieldStatuses));

  // 4. Interior tab <- Lobby x2 only (Fitness Center removed).
  const r4 = await updateMiblockRecordAsset({
    miBlockId: GALLERY_MIBLOCK_ID,
    recordId: interior.Id,
    assetFields: [{ fieldAlias: 'gallery-images', assetUrls: [LOBBY_1_URL, LOBBY_6_URL] }],
  });
  console.log('4. Interior <- Lobby x2 only -> fieldStatuses:', JSON.stringify(r4.fieldStatuses));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
