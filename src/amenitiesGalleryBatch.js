import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildAmenitiesMovePlan } from './galleryPlan4.js';
import { getProfileIdForPropertyCode } from './clients/profileClient.js';
import { createComponentRecord } from './clients/miblockCreateClient.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';

const GALLERY_MIBLOCK_ID = 20133;
const PROPERTY_DATA_MIBLOCK_ID = 20132;
const SITE_ID = 17677;
const CONCURRENCY = 3;

function buildAmenitiesCreateRecord({ parentRecordId, profileId }) {
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
  return {
    RecordId: 0,
    Id: 0,
    CmpId: GALLERY_MIBLOCK_ID,
    ComponentId: GALLERY_MIBLOCK_ID,
    ParentRecordId: parentRecordId,
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
}

/**
 * Applies the surgical Amenities-move plan for one property: shrinks
 * Exterior/Interior/Rooms tabs to remove images reclassified as Amenities,
 * and creates (only if missing - duplicate-safe, see galleryPlan4.js) or
 * updates the Amenities tab with them. Properties with nothing to move are
 * untouched entirely (no writes at all).
 */
export async function applyAmenitiesMoveForProperty(propertyCode) {
  const { plan } = await buildAmenitiesMovePlan(propertyCode);
  const result = { propertyCode, tabs: [] };
  if (!plan.length) return { ...result, status: 'nothing-to-move' };

  // Shrinks run FIRST, and only images whose shrink actually succeeded are
  // added to Amenities. Previously the Amenities add ran independently of
  // shrink success - when a shrink failed (e.g. the CMS's per-field 5-asset
  // cap, seen live on RRI360/RRI479 despite CLAUDE.md documenting it as
  // lifted), the image got ADDED to Amenities anyway while staying in its
  // original tab, duplicating it. This way a failed shrink just leaves that
  // image where it already was - no duplicate, no loss.
  const confirmedMoved = [];
  for (const entry of plan) {
    if (entry.action !== 'shrink-remove-amenities') continue;
    const updateResult = await updateMiblockRecordAsset({
      miBlockId: entry.miBlockId,
      recordId: entry.recordId,
      assetFields: [{ fieldAlias: entry.fieldAlias, assetUrls: entry.assetUrls }],
    });
    const ok = (updateResult.fieldStatuses || []).every((f) => f.Success !== false);
    result.tabs.push({ category: entry.category, action: 'shrink', result: ok ? 'ok' : 'check', removed: entry.removed, fieldStatuses: ok ? undefined : updateResult.fieldStatuses });
    if (ok) confirmedMoved.push(...entry.movedItems);
  }

  const amenitiesEntry = plan.find((e) => e.category === 'Amenities');
  if (amenitiesEntry && confirmedMoved.length) {
    const existingUrls = (amenitiesEntry.assetUrls || []).filter((url) => !amenitiesEntry.moved.some((m) => m.url === url) || confirmedMoved.some((m) => m.url === url));
    const finalUrls = [...new Set([...existingUrls, ...confirmedMoved.map((m) => m.url)])];

    if (amenitiesEntry.action === 'create-then-update') {
      const profileId = await getProfileIdForPropertyCode(propertyCode);
      if (!profileId) {
        result.tabs.push({ category: 'Amenities', action: 'create', result: 'error', error: 'no-profile-id' });
      } else {
        const record = buildAmenitiesCreateRecord({ parentRecordId: amenitiesEntry.propertyRecordId, profileId });
        const createResult = await createComponentRecord({ componentAliasName: 'Property-Level-Gallery', records: [record] });
        const newRecordId = createResult.body?.componentRecordDetails?.recordsDetails?.[0]?.recordId;
        if (!createResult.body?.Success || !newRecordId) {
          result.tabs.push({ category: 'Amenities', action: 'create', result: 'error', error: 'create-failed', detail: createResult.body });
        } else {
          const updateResult = await updateMiblockRecordAsset({
            miBlockId: GALLERY_MIBLOCK_ID,
            recordId: newRecordId,
            assetFields: [{ fieldAlias: amenitiesEntry.fieldAlias, assetUrls: finalUrls }],
          });
          const ok = (updateResult.fieldStatuses || []).every((f) => f.Success !== false);
          result.tabs.push({ category: 'Amenities', action: 'create+update', result: ok ? 'ok' : 'check', recordId: newRecordId, moved: confirmedMoved.map((m) => m.fileName), fieldStatuses: ok ? undefined : updateResult.fieldStatuses });
        }
      }
    } else {
      const updateResult = await updateMiblockRecordAsset({
        miBlockId: amenitiesEntry.miBlockId,
        recordId: amenitiesEntry.recordId,
        assetFields: [{ fieldAlias: amenitiesEntry.fieldAlias, assetUrls: finalUrls }],
      });
      const ok = (updateResult.fieldStatuses || []).every((f) => f.Success !== false);
      result.tabs.push({ category: 'Amenities', action: 'update', result: ok ? 'ok' : 'check', recordId: amenitiesEntry.recordId, moved: confirmedMoved.map((m) => m.fileName), fieldStatuses: ok ? undefined : updateResult.fieldStatuses });
    }
  }

  return { ...result, status: 'ok' };
}

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    while (next < items.length) await worker(items[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

async function main() {
  const [, , startArg, sizeArg] = process.argv;
  const start = parseInt(startArg, 10) || 0;
  const size = parseInt(sizeArg, 10) || 10;

  const allCodes = JSON.parse(await readFile('output/property-codes.json', 'utf8'));
  const slice = allCodes.slice(start, start + size);
  console.log(`Amenities move for ${slice.length} properties (index ${start}..${start + slice.length - 1} of ${allCodes.length})`);

  const summary = [];
  let done = 0;
  await runWithConcurrency(slice, CONCURRENCY, async (code) => {
    try {
      summary.push(await applyAmenitiesMoveForProperty(code));
    } catch (err) {
      summary.push({ propertyCode: code, status: 'error', error: err.message });
    } finally {
      done += 1;
      if (done % 5 === 0 || done === slice.length) console.log(`Progress: ${done}/${slice.length}`);
    }
  });

  await mkdir('output', { recursive: true });
  await writeFile(`output/amenities-gallery-batch-${start}-${start + slice.length}.json`, JSON.stringify(summary, null, 2));

  const masterFile = 'output/amenities-gallery-by-property.json';
  let master = {};
  try { master = JSON.parse(await readFile(masterFile, 'utf8')); } catch { master = {}; }
  for (const s of summary) master[s.propertyCode] = { ...s, timestamp: new Date().toISOString() };
  await writeFile(masterFile, JSON.stringify(master, null, 2));

  const moved = summary.filter((s) => s.status === 'ok');
  const errors = summary.filter((s) => s.status === 'error');
  console.log('\n--- Batch summary ---');
  console.log(`ok-with-moves: ${moved.length} | nothing-to-move: ${summary.filter((s) => s.status === 'nothing-to-move').length} | errors: ${errors.length}`);
  for (const s of moved) console.log(s.propertyCode, '->', (s.tabs || []).map((t) => `${t.category}(${t.action}):${t.result}`).join(' | '));
  for (const e of errors) console.log('ERROR', e.propertyCode, '->', e.error);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
