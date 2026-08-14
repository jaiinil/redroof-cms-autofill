import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildPlanForProperty } from './planForProperty.js';

// Usage: node src/analyze.js <propertyCode>
const [, , propertyCode] = process.argv;

if (!propertyCode) {
  console.error('Usage: node src/analyze.js <propertyCode>');
  process.exit(1);
}

async function main() {
  const { propertyRecords, referenceRooms, plan } = await buildPlanForProperty(propertyCode);

  await mkdir('output', { recursive: true });
  const outFile = `output/${propertyCode}.plan.json`;
  await writeFile(outFile, JSON.stringify(plan, null, 2));

  console.log(`Property code: ${propertyCode}`);
  console.log(`CMS property-data records: ${propertyRecords.length} | Reference room types: ${referenceRooms.length}`);
  console.table(
    plan.map((p) => ({
      propertyRecordId: p.propertyRecordId,
      roomTypeCode: p.roomTypeCode,
      action: p.action,
      recordId: p.recordId ?? '-',
    }))
  );
  console.log(`Full plan saved to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
