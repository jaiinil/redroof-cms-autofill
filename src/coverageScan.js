import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { getComponentData } from './clients/cmsClient.js';

// READ-ONLY. Current image state of every property: listing-page-image,
// each property-level-gallery tab, and room-type room-images.
//
// CAVEAT: GetComponentData lags hours behind writes for 20132/20133, so a
// property written recently can read as 0 when it is not. Each row is flagged
// with whether we wrote to it in this session so those can be discounted.

const TABS = ['Exterior', 'Interior', 'Rooms'];
const CONCURRENCY = 3;
const RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const codes = JSON.parse(await readFile('output/property-codes.json', 'utf8'));

async function loadJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return {}; }
}
const damWritten = await loadJson('output/dam-gallery-by-property.json');
const lgWritten = await loadJson('output/listing-gallery-by-property.json');

const rows = [];
let idx = 0;
let done = 0;

async function worker() {
  while (true) {
    const code = codes[idx++];
    if (!code) return;
    try {
      let recs = [];
      for (let a = 1; a <= RETRIES; a++) {
        const d = await getComponentData(code);
        recs = d.MainFilterObj || [];
        if (recs.length) break;
        if (a < RETRIES) await sleep(1000 * a);
      }
      if (!recs.length) {
        rows.push({ code, status: 'no-property-record' });
      } else {
        for (const pr of recs) {
          const gal = (pr.ChildRecords || []).filter((r) => r.ComponentAliasName === 'property-level-gallery');
          const rt = (pr.ChildRecords || []).filter((r) => r.ComponentAliasName === 'room-type');
          const tabCount = {};
          for (const t of TABS) {
            const rec = gal.find((g) => (g.Data['gallery-tab-name'] || '').trim().toLowerCase() === t.toLowerCase());
            tabCount[t] = rec ? (rec.Data['gallery-images'] || []).length : null; // null = tab record missing
          }
          rows.push({
            code,
            status: 'ok',
            recordId: pr.Id,
            listing: (pr.Data['listing-page-image'] || []).length,
            exterior: tabCount.Exterior,
            interior: tabCount.Interior,
            rooms: tabCount.Rooms,
            roomTypeRecords: rt.length,
            roomTypesWithoutImage: rt.filter((r) => (r.Data['room-images'] || []).length === 0).length,
            writtenThisSession: !!(damWritten[code] || lgWritten[code]),
          });
        }
      }
    } catch (err) {
      rows.push({ code, status: 'error', error: err.message });
    }
    if (++done % 50 === 0) console.log(`${done}/${codes.length}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
rows.sort((a, b) => a.code.localeCompare(b.code));

await writeFile('output/image-zero-report.json', JSON.stringify(rows, null, 2));
const header = 'propertyCode,recordId,listingImages,exterior,interior,rooms,roomTypeRecords,roomTypesWithoutImage,status';
const csv = rows.map((r) => [r.code, r.recordId ?? '', r.listing ?? '', r.exterior ?? 'NO_TAB', r.interior ?? 'NO_TAB', r.rooms ?? 'NO_TAB', r.roomTypeRecords ?? '', r.roomTypesWithoutImage ?? '', r.status].join(','));
await writeFile('output/image-zero-report.csv', [header, ...csv].join('\n'));

const ok = rows.filter((r) => r.status === 'ok');
const zero = (f) => ok.filter((r) => r[f] === 0);
const allZero = ok.filter((r) => r.listing === 0 && r.exterior === 0 && r.interior === 0 && r.rooms === 0);
const totallyEmpty = allZero.filter((r) => r.roomTypeRecords > 0 && r.roomTypesWithoutImage === r.roomTypeRecords);

console.log('\n================ SUMMARY ================');
console.log('property records scanned :', ok.length, '| codes:', new Set(ok.map((r) => r.code)).size);
console.log('listing image = 0        :', zero('listing').length);
console.log('Exterior = 0             :', zero('exterior').length);
console.log('Interior = 0             :', zero('interior').length);
console.log('Rooms = 0                :', zero('rooms').length);
console.log('no room-type records     :', ok.filter((r) => r.roomTypeRecords === 0).length);
console.log('every room-type w/o image:', ok.filter((r) => r.roomTypeRecords > 0 && r.roomTypesWithoutImage === r.roomTypeRecords).length);
console.log('ALL FOUR image fields = 0:', allZero.length);
console.log('   ...and no room images :', totallyEmpty.length);
console.log('\nALL-ZERO PROPERTIES:');
console.log(allZero.map((r) => r.code).join(', ') || '(none)');
console.log('\nof those, written this session (read may just be lagging):');
console.log(allZero.filter((r) => r.writtenThisSession).map((r) => r.code).join(', ') || '(none)');
