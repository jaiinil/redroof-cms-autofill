import 'dotenv/config';
import { getComponentData } from './clients/cmsClient.js';
import { updateMiblockRecordAsset } from './clients/miblockWriteClient.js';

// One-off, already-applied fix (2026-08-19) - kept as a script rather than
// only an ad-hoc command, per this project's convention that every write is
// reproducible from source, not just logged.
//
// RediStay's reference API points several rooms at its own generic "no real
// photo" placeholder filenames (e.g. "Red-Roof-Inn-Default-Room-Image-1-Bed.jpg")
// that were never uploaded to DAM. The user uploaded a real single-bed stock
// photo to a SHARED (non-property) DAM folder as a stand-in for the missing
// "1-Bed" default - this applies that URL to every room the 2026-08-19 audit
// found still pointing at that exact placeholder name with no DAM match.
//
// Does NOT cover rooms with a unique, non-placeholder expected filename (see
// output/fix-accuracy-issues-result.json's "still-no-dam-match" entries with
// a non-generic name, e.g. RRI121/RRI148) - those need their own real photo
// uploaded, a generic default would be actively wrong for them.

const DEFAULT_1BED_URL = 'https://assets.milestoneinternet.com/red-roof/other-images/rri-default-room-image.jpg';
const ROOM_TYPE_MIBLOCK_ID = 20135;

const TARGETS = [
  { code: 'RRI1200', rooms: ['ND1KM', 'SD1KM', 'ND1KK', 'ND1KMU', 'NP1KMU', 'NP1KMJ', 'SD1KMJ', 'NT1KMJ', 'NT1KK'] },
  { code: 'RRI350', rooms: ['SD1KK'] },
  { code: 'RRI368', rooms: ['ND1KM'] },
  { code: 'RRI419', rooms: ['SD1QK'] },
];

async function main() {
  for (const t of TARGETS) {
    const cmsData = await getComponentData(t.code);
    const pr = cmsData.MainFilterObj?.[0];
    for (const roomCode of t.rooms) {
      const rt = (pr?.ChildRecords || []).find((c) => c.ComponentAliasName === 'room-type' && c.Data['room-type-code'] === roomCode);
      if (!rt) { console.log(t.code, roomCode, '-> NO CMS RECORD FOUND'); continue; }
      const r = await updateMiblockRecordAsset({
        miBlockId: ROOM_TYPE_MIBLOCK_ID,
        recordId: rt.Id,
        assetFields: [{ fieldAlias: 'room-images', assetUrls: [DEFAULT_1BED_URL] }],
      });
      const ok = (r.fieldStatuses || []).every((f) => f.Success !== false);
      console.log(t.code, roomCode, '->', ok ? 'fixed' : 'FAILED', JSON.stringify(r.fieldStatuses));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
