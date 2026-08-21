import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { getWebContent } from './clients/redistayClient.js';

// One-off audit (2026-08-21): after fixing the \bpool\b word-boundary bug in
// galleryPlan4.js's classify(), re-check every property that already had an
// Amenities move applied against the FIXED classifier. Any image that was
// moved under the OLD (buggy) classifier but would NOT be classified as
// Amenities under the FIXED one is a false positive that needs to be moved
// back to wherever it came from.

function classifyFixed(item) {
  const raw = `${item.Image?.AlternateText || ''} ${item.Caption || ''}`.toLowerCase();
  const text = raw.replace(/[_-]+/g, ' ');
  if (text.includes('bath')) return 'Interior';
  if (/\bpool\b|\bfitness\b|\bgym\b|business center|\bvending\b|\blaundry\b|meeting room|\bconference\b/.test(text)) return 'Amenities';
  if (/\bexterior\b|\btwilight\b|\bpatio\b|\bcourtyard\b|\bpicnic\b|dog park|pet area|fire pit|ev charging|\bplayground\b/.test(text)) return 'Exterior';
  if (/\b(king|queen|suite|studio|bed|beds|room)\b/.test(text)) return 'Rooms';
  return 'Interior';
}

function normalizeFileName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function main() {
  const master = JSON.parse(await readFile('output/amenities-gallery-by-property.json', 'utf8'));
  const affected = [];

  for (const [propertyCode, rec] of Object.entries(master)) {
    const amenitiesTab = (rec.tabs || []).find((t) => t.category === 'Amenities');
    const movedNames = amenitiesTab?.moved;
    if (!movedNames || !movedNames.length) continue;

    const referenceData = await getWebContent([propertyCode]);
    const galleryItems = referenceData?.Data?.Results?.[0]?.ImageGallery || [];

    const falsePositives = [];
    for (const fileName of movedNames) {
      const refItem = galleryItems.find((it) => normalizeFileName(it.Image?.FileName) === normalizeFileName(fileName));
      if (refItem && classifyFixed(refItem) !== 'Amenities') {
        falsePositives.push({ fileName, correctCategory: classifyFixed(refItem), caption: refItem.Caption, alt: refItem.Image?.AlternateText });
      }
    }
    if (falsePositives.length) {
      affected.push({ propertyCode, falsePositives });
      console.log(propertyCode, '->', JSON.stringify(falsePositives.map((f) => f.fileName)));
    }
  }

  console.log('\nTotal properties with false positives:', affected.length);
  await writeFile('output/amenities-false-positives.json', JSON.stringify(affected, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
