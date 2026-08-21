import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { applyAmenitiesMoveForProperty } from './amenitiesGalleryBatch.js';

// Re-runs just the property codes that failed in a prior amenitiesGalleryBatch.js
// run (list passed as argv), after the retry-on-empty-read fix in galleryPlan4.js.
const CONCURRENCY = 3;

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    while (next < items.length) await worker(items[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

async function main() {
  const codes = process.argv.slice(2);
  console.log(`Retrying ${codes.length} previously-failed properties`);

  const summary = [];
  let done = 0;
  await runWithConcurrency(codes, CONCURRENCY, async (code) => {
    try {
      summary.push(await applyAmenitiesMoveForProperty(code));
    } catch (err) {
      summary.push({ propertyCode: code, status: 'error', error: err.message });
    } finally {
      done += 1;
      if (done % 10 === 0 || done === codes.length) console.log(`Progress: ${done}/${codes.length}`);
    }
  });

  const masterFile = 'output/amenities-gallery-by-property.json';
  let master = {};
  try { master = JSON.parse(await readFile(masterFile, 'utf8')); } catch { master = {}; }
  for (const s of summary) master[s.propertyCode] = { ...s, timestamp: new Date().toISOString() };
  await writeFile(masterFile, JSON.stringify(master, null, 2));
  await writeFile('output/amenities-gallery-retry-0-100.json', JSON.stringify(summary, null, 2));

  const errors = summary.filter((s) => s.status === 'error');
  console.log('\n--- Retry summary ---');
  console.log(`ok-with-moves: ${summary.filter((s) => s.status === 'ok').length} | nothing-to-move: ${summary.filter((s) => s.status === 'nothing-to-move').length} | errors: ${errors.length}`);
  for (const s of summary.filter((s) => s.status === 'ok')) console.log(s.propertyCode, '->', (s.tabs || []).map((t) => `${t.category}(${t.action}):${t.result}`).join(' | '));
  for (const e of errors) console.log('ERROR', e.propertyCode, '->', e.error);
}

main().catch((err) => { console.error(err); process.exit(1); });
