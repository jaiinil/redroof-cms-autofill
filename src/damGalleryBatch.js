import 'dotenv/config';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { getComponentData } from './clients/cmsClient.js';
import { listPropertyImages } from './clients/damClient.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';

const GALLERY_MIBLOCK_ID = 20133;
const MAX_GALLERY_IMAGES = 5;
const CONCURRENCY = 3;
const EMPTY_RESPONSE_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fills property-level-gallery straight from the property's DAM folder,
 * categorising by FILENAME.
 *
 * This deliberately bypasses the RediStay reference API, which is what
 * galleryPlan.js uses (standing rules 2 and 4). Confirmed with the user as a
 * replacement approach: the reference API's ImageGallery is a smaller,
 * differently-ordered subset, and its AlternateText is what categorisation
 * used to hang off. Here the DAM folder is the source of truth and the
 * filename is the only signal.
 *
 * Rule 4 is still honoured: a bathroom shot is Interior even when the
 * filename also names a room type ("suite-1-king-vanity-bath" -> Interior).
 */
// Assets the DAM still holds but nobody should publish. "-delete" is an
// explicit retire marker (52 of them across a 6-property sample) - the first
// run picked several before this filter existed. "temp-approved" is NOT junk:
// it is a normal approval state and those images are in active use.
// "sign-off" files are signage/approval sheets, not property photography.
const isRetired = (n) => /delete|sign-off|signoff/i.test(n);

// "HomeTowne Studios" is a brand name, so the word "studio" appears in
// filenames that have nothing to do with a guest room - it put a ballroom /
// conference-centre shot in the Rooms tab on the first run. Strip the brand
// before classifying, and keep event space out of Rooms explicitly.
// Spelled both "hometowne-studios" and "hometown-studios" in the DAM.
const forClassify = (n) => n.toLowerCase().replace(/hometowne?-studios/g, '').replace(/\.[a-z]+$/, '');

const isBath = (n) => /bath|vanity|shower|tub/.test(forClassify(n));
const isExterior = (n) => /exterior|picnic|pool|patio|courtyard|playground/.test(forClassify(n));
const isEventSpace = (n) => /ballroom|conference|banquet|event-space/.test(forClassify(n));
const isRoom = (n) => !isEventSpace(n) && /studio|suite|king|queen|full|double|bed/.test(forClassify(n));

// Interior is by far the biggest bucket and only 5 slots exist, so order it
// editorially: the shots a guest actually wants first, bathroom close-ups last.
const INTERIOR_ORDER = ['lobby-1', 'lobby', 'front-desk', 'reception', 'breakfast', 'dining', 'fitness', 'business', 'meeting', 'game-room', 'market', 'laundry', 'vending'];
const interiorRank = (n) => {
  const i = INTERIOR_ORDER.findIndex((k) => n.toLowerCase().includes(k));
  return i < 0 ? (isBath(n) ? 99 : 50) : i;
};

// One image per room family, so five different room types show rather than
// five variants of the same one. Every digit group is stripped, not just the
// trailing one: these filenames carry the variant number TWICE
// ("...1king-1-pro-approved-3-26-25-nae1k-1"), and stripping only the tail
// left five near-identical keys, which is how five shots of the same ADA
// studio filled a whole Rooms tab on the first run.
const roomFamily = (n) =>
  forClassify(n).replace(/\d+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

export function buildDamGalleryPlan(allImages) {
  const images = allImages.filter((a) => !isRetired(a.alias));
  const exterior = images.filter((a) => isExterior(a.alias) && !isBath(a.alias));
  const rooms = images.filter((a) => !isExterior(a.alias) && !isBath(a.alias) && isRoom(a.alias));
  const interior = images.filter((a) => !isExterior(a.alias) && (isBath(a.alias) || !isRoom(a.alias)));

  // One per room family first (so five different room types lead), then
  // backfill from the leftover variants - otherwise a property with three
  // room types but plenty of photos shows a three-image Rooms tab.
  const sortedRooms = [...rooms].sort((x, y) => x.alias.localeCompare(y.alias));
  const seen = new Set();
  const roomPick = [];
  const leftovers = [];
  for (const a of sortedRooms) {
    const f = roomFamily(a.alias);
    if (seen.has(f)) { leftovers.push(a); continue; }
    seen.add(f);
    roomPick.push(a);
  }
  for (const a of leftovers) {
    if (roomPick.length >= MAX_GALLERY_IMAGES) break;
    roomPick.push(a);
  }

  return {
    Exterior: exterior.slice(0, MAX_GALLERY_IMAGES),
    Interior: [...interior].sort((x, y) => interiorRank(x.alias) - interiorRank(y.alias) || x.alias.localeCompare(y.alias)).slice(0, MAX_GALLERY_IMAGES),
    Rooms: roomPick.slice(0, MAX_GALLERY_IMAGES),
  };
}

export async function applyDamGalleryForProperty(propertyCode) {
  let propertyRecords = [];
  for (let attempt = 1; attempt <= EMPTY_RESPONSE_RETRIES; attempt++) {
    const cms = await getComponentData(propertyCode);
    propertyRecords = cms.MainFilterObj || [];
    if (propertyRecords.length) break;
    if (attempt < EMPTY_RESPONSE_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
  }
  if (!propertyRecords.length) return { propertyCode, status: 'no-property-record' };

  const images = await listPropertyImages(propertyCode);
  if (!images.length) return { propertyCode, status: 'no-dam-images', damImageCount: 0 };

  const plan = buildDamGalleryPlan(images);
  const result = { propertyCode, status: 'ok', damImageCount: images.length, tabs: [] };

  for (const pr of propertyRecords) {
    for (const g of (pr.ChildRecords || []).filter((r) => r.ComponentAliasName === 'property-level-gallery')) {
      const tab = (g.Data['gallery-tab-name'] || '').trim();
      const picks = plan[tab] || [];
      if (!picks.length) {
        result.tabs.push({ parentRecordId: pr.Id, tab, recordId: g.Id, result: 'skip:no-candidates' });
        continue;
      }
      const r = await updateMiblockRecordAsset({
        miBlockId: GALLERY_MIBLOCK_ID,
        recordId: g.Id,
        assetFields: [{ fieldAlias: 'gallery-images', assetUrls: picks.map((a) => a.assetPath) }],
      });
      const ok = (r.fieldStatuses || []).every((f) => f.Success !== false) && !r.missingAliases.length;
      result.tabs.push({
        parentRecordId: pr.Id,
        tab,
        recordId: g.Id,
        images: picks.length,
        files: picks.map((a) => a.alias),
        result: ok ? 'ok' : 'check',
        ...(ok ? {} : { fieldStatuses: r.fieldStatuses }),
      });
    }
  }

  return result;
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
  const size = parseInt(sizeArg, 10) || 1000;

  const pending = JSON.parse(await readFile('output/gallery-limit-pending.json', 'utf8')).map((r) => r.code);
  const slice = pending.slice(start, start + size);
  console.log(`DAM-sourced gallery for ${slice.length} properties (index ${start}..${start + slice.length - 1} of ${pending.length})`);

  const summary = [];
  let done = 0;
  await runWithConcurrency(slice, CONCURRENCY, async (code) => {
    try {
      summary.push(await applyDamGalleryForProperty(code));
    } catch (err) {
      summary.push({ propertyCode: code, status: 'error', error: err.message });
    } finally {
      done += 1;
      if (done % 20 === 0 || done === slice.length) console.log(`Progress: ${done}/${slice.length}`);
    }
  });

  await mkdir('output', { recursive: true });
  await writeFile(`output/dam-gallery-batch-${start}-${start + slice.length}.json`, JSON.stringify(summary, null, 2));

  const masterFile = 'output/dam-gallery-by-property.json';
  let master = {};
  try { master = JSON.parse(await readFile(masterFile, 'utf8')); } catch { master = {}; }
  for (const s of summary) master[s.propertyCode] = { ...s, timestamp: new Date().toISOString() };
  await writeFile(masterFile, JSON.stringify(master, null, 2));

  const t = summary.reduce((acc, s) => {
    if (s.status === 'error') acc.errors += 1;
    else if (s.status !== 'ok') acc[s.status] = (acc[s.status] || 0) + 1;
    else {
      acc.ok += 1;
      acc.tabsFilled += s.tabs.filter((x) => x.result === 'ok').length;
      acc.images += s.tabs.filter((x) => x.result === 'ok').reduce((n, x) => n + x.images, 0);
      acc.tabsChecked += s.tabs.filter((x) => x.result === 'check').length;
      acc.tabsSkipped += s.tabs.filter((x) => String(x.result).startsWith('skip')).length;
    }
    return acc;
  }, { ok: 0, errors: 0, tabsFilled: 0, images: 0, tabsChecked: 0, tabsSkipped: 0 });

  console.log('\n--- Batch summary ---');
  console.log(JSON.stringify(t, null, 1));
  for (const e of summary.filter((s) => s.status === 'error')) console.log(`ERROR ${e.propertyCode}: ${e.error}`);
  for (const s of summary.filter((x) => x.status === 'no-dam-images')) console.log(`no DAM images: ${s.propertyCode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
