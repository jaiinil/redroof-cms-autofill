import 'dotenv/config';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { buildPlanForProperty } from './planForProperty.js';

const CONCURRENCY = 5;

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

async function main() {
  const codes = JSON.parse(await readFile('output/property-codes.json', 'utf8'));
  await mkdir('output/plans', { recursive: true });

  let done = 0;
  const summary = [];

  await runWithConcurrency(codes, CONCURRENCY, async (code) => {
    try {
      const { plan } = await buildPlanForProperty(code);
      await writeFile(`output/plans/${code}.json`, JSON.stringify(plan, null, 2));

      const counts = plan.reduce((acc, p) => {
        acc[p.action] = (acc[p.action] || 0) + 1;
        return acc;
      }, {});

      summary.push({ propertyCode: code, status: 'ok', ...counts });
    } catch (err) {
      summary.push({ propertyCode: code, status: 'error', error: err.message });
    } finally {
      done += 1;
      if (done % 25 === 0 || done === codes.length) {
        console.log(`Progress: ${done}/${codes.length}`);
      }
    }
  });

  await writeFile('output/batch-summary.json', JSON.stringify(summary, null, 2));

  const totals = summary.reduce(
    (acc, s) => {
      if (s.status === 'error') {
        acc.errors += 1;
      } else {
        acc.update += s.update || 0;
        acc['skip-already-has-image'] += s['skip-already-has-image'] || 0;
        acc['skip-no-cms-record'] += s['skip-no-cms-record'] || 0;
      }
      return acc;
    },
    { update: 0, 'skip-already-has-image': 0, 'skip-no-cms-record': 0, errors: 0 }
  );

  console.log('\n--- Batch summary ---');
  console.log(`Properties processed: ${codes.length}`);
  console.log(`Properties with errors: ${totals.errors}`);
  console.log(`Room-type images to update: ${totals.update}`);
  console.log(`Room-types already have images (skipped): ${totals['skip-already-has-image']}`);
  console.log(`Room-types with no matching CMS record (skipped): ${totals['skip-no-cms-record']}`);
  console.log('\nFull summary: output/batch-summary.json');
  console.log('Per-property plans: output/plans/<code>.json');

  const errored = summary.filter((s) => s.status === 'error');
  if (errored.length) {
    console.log('\n--- Errors ---');
    for (const e of errored) console.log(`${e.propertyCode}: ${e.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
