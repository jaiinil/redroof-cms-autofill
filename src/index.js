import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { getComponentData } from './clients/cmsClient.js';
import { getWebContent } from './clients/redistayClient.js';

// Usage: node src/index.js <cmsPropertyCode> [referencePropertyId]
// referencePropertyId defaults to cmsPropertyCode if not given.
const [, , cmsPropertyCode, referencePropertyId = cmsPropertyCode] = process.argv;

if (!cmsPropertyCode) {
  console.error('Usage: node src/index.js <cmsPropertyCode> [referencePropertyId]');
  process.exit(1);
}

async function main() {
  const [cmsData, referenceData] = await Promise.all([
    getComponentData(cmsPropertyCode),
    getWebContent([referencePropertyId]),
  ]);

  await mkdir('output', { recursive: true });
  await writeFile(`output/${cmsPropertyCode}.cms.json`, JSON.stringify(cmsData, null, 2));
  await writeFile(`output/${referencePropertyId}.reference.json`, JSON.stringify(referenceData, null, 2));

  console.log(`Saved:`);
  console.log(`  output/${cmsPropertyCode}.cms.json`);
  console.log(`  output/${referencePropertyId}.reference.json`);

  // TODO: once field mapping (which CMS field IDs correspond to which
  // reference fields) is provided, add a compare step here that diffs the
  // two payloads and reports what needs to be filled/updated in the CMS.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
