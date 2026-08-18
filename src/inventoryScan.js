import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { getComponentData } from './clients/cmsClient.js';

// READ-ONLY. Per property: listing image count, each gallery tab's image
// count, room-type record count, and the image count on every individual
// room-type record.
const TABS = ['Exterior', 'Interior', 'Rooms'];
const CONCURRENCY = 3;
const RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const codes = JSON.parse(await readFile('output/property-codes.json', 'utf8'));
const rows = [];
let idx = 0, done = 0;

async function worker() {
  while (true) {
    const code = codes[idx++];
    if (!code) return;
    try {
      let recs = [];
      for (let a = 1; a <= RETRIES; a++) {
        recs = (await getComponentData(code)).MainFilterObj || [];
        if (recs.length) break;
        if (a < RETRIES) await sleep(1000 * a);
      }
      if (!recs.length) { rows.push({ code, status: 'no-property-record' }); }
      else for (const pr of recs) {
        const gal = (pr.ChildRecords || []).filter((r) => r.ComponentAliasName === 'property-level-gallery');
        const tabs = {};
        for (const t of TABS) {
          const rec = gal.find((g) => (g.Data['gallery-tab-name'] || '').trim().toLowerCase() === t.toLowerCase());
          tabs[t] = rec ? (rec.Data['gallery-images'] || []).length : null;
        }
        const rooms = (pr.ChildRecords || [])
          .filter((r) => r.ComponentAliasName === 'room-type')
          .map((r) => ({ code: r.Data['room-type-code'] || '(no code)', images: (r.Data['room-images'] || []).length }))
          .sort((a, b) => a.code.localeCompare(b.code));
        rows.push({
          code, status: 'ok', recordId: pr.Id,
          listing: (pr.Data['listing-page-image'] || []).length,
          exterior: tabs.Exterior, interior: tabs.Interior, rooms: tabs.Rooms,
          galleryTotal: TABS.reduce((n, t) => n + (tabs[t] || 0), 0),
          roomTypeCount: rooms.length,
          roomsWithImage: rooms.filter((r) => r.images > 0).length,
          roomDetail: rooms,
        });
      }
    } catch (err) {
      rows.push({ code, status: 'error', error: err.message });
    }
    if (++done % 50 === 0) console.log(`${done}/${codes.length}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
rows.sort((a, b) => a.code.localeCompare(b.code));
await writeFile('output/consolidated-report.json', JSON.stringify(rows, null, 1));

// property-level CSV
const head = 'propertyCode,recordId,listingImages,exterior,interior,rooms,galleryTotal,roomTypeCount,roomsWithImage,roomsWithoutImage,status';
const lines = rows.map((r) => r.status !== 'ok'
  ? [r.code, '', '', '', '', '', '', '', '', '', r.status].join(',')
  : [r.code, r.recordId, r.listing, r.exterior ?? 'NO_TAB', r.interior ?? 'NO_TAB', r.rooms ?? 'NO_TAB',
     r.galleryTotal, r.roomTypeCount, r.roomsWithImage, r.roomTypeCount - r.roomsWithImage, 'ok'].join(','));
await writeFile('output/consolidated-report.csv', [head, ...lines].join('\n'));

// room-level CSV, one line per room-type record
const rHead = 'propertyCode,recordId,roomTypeCode,images';
const rLines = rows.filter((r) => r.status === 'ok').flatMap((r) => r.roomDetail.map((x) => [r.code, r.recordId, x.code, x.images].join(',')));
await writeFile('output/consolidated-rooms.csv', [rHead, ...rLines].join('\n'));

const ok = rows.filter((r) => r.status === 'ok');
console.log('\nproperty rows:', rows.length, '| ok:', ok.length, '| problems:', rows.length - ok.length);
console.log('room-type records:', rLines.length);
console.log('listing set:', ok.filter((r) => r.listing > 0).length, '| gallery images:', ok.reduce((n, r) => n + r.galleryTotal, 0));
console.log('rooms with image:', ok.reduce((n, r) => n + r.roomsWithImage, 0), 'of', ok.reduce((n, r) => n + r.roomTypeCount, 0));
