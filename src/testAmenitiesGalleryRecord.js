import 'dotenv/config';
import { getComponentData } from './clients/cmsClient.js';
import { getProfileIdForPropertyCode } from './clients/profileClient.js';
import { createComponentRecord } from './clients/miblockCreateClient.js';

// One-off test (2026-08-21): confirm a NEW 4th property-level-gallery tab
// ("Amenities", client-requested category alongside Exterior/Interior/Rooms)
// can be created via CreateComponentRecord the same way room-type records
// are - Profile-linked, no images yet. Just checking the record appears
// correctly in CMS admin before this becomes a real pattern for a batch.

const GALLERY_MIBLOCK_ID = 20133;
const PROPERTY_DATA_MIBLOCK_ID = 20132;
const SITE_ID = 17677;
const PROPERTY_CODE = 'RRI207';

async function main() {
  const cms = await getComponentData(PROPERTY_CODE);
  const pr = cms.MainFilterObj?.[0];
  if (!pr) throw new Error(`No property-data record found for ${PROPERTY_CODE}`);

  const profileId = await getProfileIdForPropertyCode(PROPERTY_CODE);
  if (!profileId) throw new Error(`No ProfileId found for ${PROPERTY_CODE}`);

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

  console.log('ParentRecordId (property-data Id):', pr.Id, '| ProfileId:', profileId);

  const result = await createComponentRecord({ componentAliasName: 'Property-Level-Gallery', records: [record] });
  const newRecordId = result.body?.componentRecordDetails?.recordsDetails?.[0]?.recordId;
  console.log('Success:', result.body?.Success, '| New RecordId:', newRecordId, '| ErrorMessage:', result.body?.ErrorMessage || '(none)');
  console.log(JSON.stringify(result.body, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
