# redroof-cms-autofill

Automation that fills gaps in the Red Roof CMS (Milestone MiBlock) by cross-referencing the
RediStay reference API and matching real DAM assets — per property. It updates/creates
`room-type` records, refreshes the `property-level-gallery` (Exterior/Interior/Rooms), and
refreshes `listing-page-image`.

> For full technical context (API shapes, field mappings, known gaps, standing business rules),
> see [`CLAUDE.md`](./CLAUDE.md). This file is the practical "how do I run this" guide.

## 1. Setup

```bash
git clone https://github.com/jaiinil/redroof-cms-autofill.git
cd redroof-cms-autofill
npm install
cp .env.example .env
```

Then fill in `.env`:

| Variable | Where to get it |
|---|---|
| `REDISTAY_SUBSCRIPTION_KEY` | Ask the team for the RediStay `Ocp-Apim-Subscription-Key`. |
| `CMS_BEARER_TOKEN` | Log into the CMS at `redroof.cms.milestoneinternet.info`. In browser DevTools → Application/Storage → Cookies, copy the value of the `mscmswt` cookie. |
| `CMS_SESSION_COOKIE` | From the same cookies, copy `ASP.NET_SessionId` and set this to `ASP.NET_SessionId=<value>`. |
| `CMS_CLIENT_APP` | Leave as `ProgrammingApp` unless told otherwise. |
| `DAM_BEARER_TOKEN` | Log into Asgard (`app.milestoneinternet.com`). Find the `.Mim.Asgard.Cookie.Production` cookie, URL-decode its value (it's JSON), and copy the `access_token` field. |
| `DAM_BUSINESS_ID` | Leave as `7976` (Red Roof) unless told otherwise. |

⚠️ **Both `CMS_BEARER_TOKEN` and `DAM_BEARER_TOKEN` expire after ~24 hours.** When calls start
returning 401, re-extract them the same way.

⚠️ **Everything in this project talks to production.** There is no staging environment. Every
write (`create`, `update-image`) is real and, for creates, there is currently no delete/undo API
wired up. Read `CLAUDE.md`'s "Working agreement with the user" section before running anything
that writes.

## 2. If you just want to see what *would* change (safe, read-only)

```bash
# Room-type plan for one property - shows create/update/skip decisions, writes nothing
node src/analyze.js RRI207

# Same, across every property code in output/property-codes.json
node src/batchAnalyze.js
```

This writes a plan to `output/<propertyCode>.plan.json` (or `output/plans/*.json` for the batch
run) — inspect that before doing anything else. It never calls a write API.

## 3. How to actually fill in ("dump") data for a property

There is no single one-shot CLI for this yet — each property is filled in three parts, in this
order. All three parts are **idempotent-safe by design** (they check current CMS/DAM state and a
local created-records registry before writing), but still: work off the plan output, and don't
blind-run this across many properties without spot-checking a few first.

Run these as inline scripts (`node -e "..."`) importing the plan builders — there is no packaged
CLI yet. Steps, for a property code (example: `RRI207`):

### Step 1 — Listing page image (always refreshed)

```js
import 'dotenv/config';
import { buildListingImagePlan } from './src/listingImagePlan.js';
import { updateMiblockRecordAsset } from './src/clients/miblockWriteClient.js';

const plan = await buildListingImagePlan('RRI207');
for (const p of plan) {
  if (p.action !== 'update-image') { console.log('skip:', p.action, p.reason); continue; }
  const result = await updateMiblockRecordAsset({
    miBlockId: p.miBlockId,
    recordId: p.recordId,
    assetFields: [{ fieldAlias: p.fieldAlias, assetUrls: [p.damImage.assetPath] }],
  });
  console.log(p.propertyRecordId, result.fieldStatuses);
}
```

### Step 2 — Property-level gallery (Exterior / Interior / Rooms — always refreshed)

```js
import 'dotenv/config';
import { buildGalleryPlan } from './src/galleryPlan.js';
import { updateMiblockRecordAsset } from './src/clients/miblockWriteClient.js';

const { plan } = await buildGalleryPlan('RRI207');
for (const p of plan) {
  if (p.action !== 'update-image') { console.log('skip:', p.category, p.action); continue; }
  const result = await updateMiblockRecordAsset({
    miBlockId: p.miBlockId,
    recordId: p.recordId,
    assetFields: [{ fieldAlias: p.fieldAlias, assetUrls: p.assetUrls }],
  });
  console.log(p.category, result.fieldStatuses);
}
```

### Step 3 — Room types (create missing ones, fill empty existing ones)

```js
import 'dotenv/config';
import { buildPlanForProperty } from './src/planForProperty.js';
import { updateMiblockRecordAsset } from './src/clients/miblockWriteClient.js';
import { createComponentRecord, buildRoomTypeRecordPayload } from './src/clients/miblockCreateClient.js';

const { plan } = await buildPlanForProperty('RRI207');

for (const p of plan) {
  if (p.action === 'update-image') {
    const result = await updateMiblockRecordAsset({
      miBlockId: p.miBlockId, recordId: p.recordId,
      assetFields: [{ fieldAlias: p.fieldAlias, assetUrls: [p.damImage.assetPath] }],
    });
    console.log(p.roomTypeCode, 'updated:', result.fieldStatuses);
  }

  if (p.action === 'create') {
    const record = buildRoomTypeRecordPayload({
      parentRecordId: p.propertyRecordId, miBlockId: p.miBlockId, siteId: 17677,
      roomTypeCode: p.roomTypeCode, roomTypeDescription: p.roomTypeDescription,
      roomImagesAlt: p.roomImagesAlt,
    });
    const createResult = await createComponentRecord({ componentAliasName: 'Room Type', records: [record] });
    const newRecordId = createResult.body?.componentRecordDetails?.recordsDetails?.[0]?.recordId;
    console.log(p.roomTypeCode, 'created:', createResult.body?.Success, newRecordId);

    if (createResult.body?.Success && newRecordId && p.damImage) {
      const imageResult = await updateMiblockRecordAsset({
        miBlockId: p.miBlockId, recordId: newRecordId,
        assetFields: [{ fieldAlias: 'room-images', assetUrls: [p.damImage.assetPath] }],
      });
      console.log(p.roomTypeCode, 'image linked:', imageResult.fieldStatuses);
    }
  }

  if (p.action.startsWith('skip')) console.log(p.roomTypeCode, 'skipped:', p.action);
}
```

Every `updateMiblockRecordAsset`/`createComponentRecord` call logs itself automatically to
`output/action-log.jsonl` — nothing extra to do for that.

## 4. Checking what didn't map

After a run, some reference-API images may have had no matching DAM asset. Regenerate the
property-grouped summary:

```js
import { summarizeNoMatchesByProperty } from './src/noMatchLog.js';
console.log(await summarizeNoMatchesByProperty());
```

This reads `output/no-image-matches.jsonl` and writes
`output/no-image-matches-by-property.json` — a per-property-code list of what still needs a
human (usually: the photo genuinely isn't uploaded to DAM yet).

## 5. Verifying a run actually landed

`GetComponentData` (the read API) has been observed to lag behind CMS admin for records just
written — sometimes badly (see `CLAUDE.md`). **After writing, verify in the CMS admin UI, not by
re-querying this API.** If you must check programmatically, cross-reference
`output/action-log.jsonl` (what we actually sent and what the API acknowledged) rather than
trusting a fresh read to reflect a very recent write.

## 6. The full list of property codes

`output/property-codes.json` (712 codes, deduplicated/case-normalized) is generated from
`data/property-codes-raw.txt` via:

```bash
node src/parsePropertyList.js
```

Re-run this only if you have a fresher property listing to paste into
`data/property-codes-raw.txt` — it also flags duplicate/conflicting codes on the way
(`output/property-codes-flagged.json`).
