import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { applyDamGalleryForProperty, buildDamGalleryPlan } from './damGalleryBatch.js';
import { buildListingImagePlan } from './listingImagePlan.js';
import { buildPlanForProperty } from './planForProperty.js';
import { listPropertyImages } from './clients/damClient.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';

// Properties whose DAM photos have just been uploaded. Fills all three
// components, update-only:
//   gallery  -> DAM-sourced (rule 4 successor)
//   listing  -> reference feed first (rule 2); DAM exterior only as fallback
//   rooms    -> reference feed's own per-room file (rule 1), existing empty
//               records only. A room-type that needs CREATING is reported,
//               never created here: creates are permanent and need the
//               Profile wiring of rule 8.

const PROPERTY_DATA_MIBLOCK_ID = 20132;
const ROOM_TYPE_MIBLOCK_ID = 20135;

// Usage: node src/fillPropertyBatch.js RRI030 RRI031 ...
//    or: node src/fillPropertyBatch.js --file output/some-codes.json
// The --file form accepts a JSON array of property codes, or an object with a
// `has` array (the shape the DAM re-check writes).
const args = process.argv.slice(2);
let codes = args.filter((a) => !a.startsWith('--'));
const fileIdx = args.indexOf('--file');
if (fileIdx !== -1) {
  const parsed = JSON.parse(await readFile(args[fileIdx + 1], 'utf8'));
  codes = Array.isArray(parsed) ? parsed : parsed.has || [];
}
if (!codes.length) throw new Error('give property codes as arguments, or --file <json>');
console.log(`filling ${codes.length} propert${codes.length === 1 ? 'y' : 'ies'}: ${codes.join(', ')}`);

const results = [];
let idx = 0;
let done = 0;

async function one(code) {
  const out = { code, gallery: null, listing: null, rooms: null, createsNeeded: [] };

  // --- gallery (DAM-sourced) ---
  const g = await applyDamGalleryForProperty(code);
  out.gallery = g.status === 'ok'
    ? (g.tabs || []).map((t) => `${t.tab[0]}:${t.result === 'ok' ? t.images : t.result}`).join(' ')
    : g.status;

  // --- listing (reference first, DAM exterior fallback) ---
  try {
    const plan = await buildListingImagePlan(code);
    for (const p of plan) {
      let url = p.action === 'update-image' ? p.damImage.assetPath : null;
      let via = 'reference';
      if (!url) {
        const dp = buildDamGalleryPlan(await listPropertyImages(code));
        const hero = dp.Exterior.find((a) => /exterior/i.test(a.alias)) || dp.Exterior[0];
        if (hero) { url = hero.assetPath; via = 'dam-fallback'; }
      }
      if (!url) { out.listing = 'no-candidate'; continue; }
      const r = await updateMiblockRecordAsset({
        miBlockId: PROPERTY_DATA_MIBLOCK_ID,
        recordId: p.recordId ?? p.propertyRecordId,
        assetFields: [{ fieldAlias: 'listing-page-image', assetUrls: [url] }],
      });
      const ok = (r.fieldStatuses || []).every((f) => f.Success !== false) && !r.missingAliases.length;
      out.listing = `${ok ? 'ok' : 'check'} (${via})`;
    }
  } catch (err) {
    out.listing = 'error: ' + err.message;
  }

  // --- room images (existing empty records only) ---
  try {
    const { plan } = await buildPlanForProperty(code);
    let updated = 0, noMatch = 0, skipped = 0;
    for (const p of plan) {
      if (p.action === 'create') { out.createsNeeded.push(p.roomTypeCode); continue; }
      if (p.action === 'update-image') {
        const r = await updateMiblockRecordAsset({
          miBlockId: p.miBlockId ?? ROOM_TYPE_MIBLOCK_ID,
          recordId: p.recordId,
          assetFields: [{ fieldAlias: 'room-images', assetUrls: [p.damImage.assetPath] }],
        });
        if ((r.fieldStatuses || []).every((f) => f.Success !== false)) updated += 1;
        continue;
      }
      if (p.action === 'skip-no-dam-image-match') noMatch += 1;
      else skipped += 1;
    }
    out.rooms = `updated=${updated} noDamMatch=${noMatch} alreadyHadImage=${skipped}`;
  } catch (err) {
    out.rooms = 'error: ' + err.message;
  }

  return out;
}

async function worker() {
  while (true) {
    const code = codes[idx++];
    if (!code) return;
    try { results.push(await one(code)); }
    catch (err) { results.push({ code, error: err.message }); }
    if (++done % 10 === 0) console.log(`${done}/${codes.length}`);
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
results.sort((a, b) => a.code.localeCompare(b.code));

await writeFile('output/fill-property-batch-result.json', JSON.stringify(results, null, 2));

console.log('\n--- results ---');
for (const r of results) {
  console.log(`${r.code.padEnd(8)} gallery[${r.gallery}]  listing[${r.listing}]  rooms[${r.rooms}]${r.createsNeeded.length ? '  CREATES-NEEDED: ' + r.createsNeeded.join(',') : ''}`);
}
const creates = results.filter((r) => r.createsNeeded?.length);
console.log(`\nproperties needing room-type CREATES (not done here): ${creates.length}`);
if (creates.length) console.log(creates.map((r) => `${r.code}(${r.createsNeeded.length})`).join(', '));
