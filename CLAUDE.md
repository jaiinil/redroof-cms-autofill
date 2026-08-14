# dam-miblock-data-poc

Automation that fills gaps in the Red Roof CMS (Milestone MiBlock/Asgard) using a RediStay
reference API as the source of truth, and DAM (Bynder/Milestone DAM) as the image source. This
file is the handoff/context doc for this project — read it fully before making any change here,
especially before running anything that writes to production.

## What this project does

For a given property code (e.g. `RRI207`), across three CMS components:

1. **`property-data`** (MiBlockId `20132`) — field `listing-page-image`: always refreshed with a
   single image (the property's exterior/hero shot).
2. **`property-level-gallery`** (MiBlockId `20133`) — field `gallery-images`, one record per tab
   (`Exterior` / `Interior` / `Rooms`): always refreshed with all matching reference-API photos for
   that category.
3. **`room-type`** (MiBlockId `20135`) — field `room-images` (+ text fields on create): for each
   room type in the reference API, either fills an existing empty CMS record's image, or creates a
   missing room-type record (text + one image).

**Everything is sourced from two read-only APIs and cross-referenced against a third (DAM) to find
the actual asset URL to write.** This project never uploads images — DAM assets must already exist.

## The APIs

| API | Purpose | Client |
|---|---|---|
| `POST /api/ComponentApi/GetComponentData` (`redroof.cms.milestoneinternet.info`) | Read CMS component data | `src/clients/cmsClient.js` |
| `POST /api/MiblockApi/UpdateMiblockRecordAsset` (same host) | Set asset/file fields on an **existing** record. Officially documented (see chat history / ask the team for the README if needed). Replaces the field, does not append. | `src/clients/miblockWriteClient.js` |
| `POST /api/MiblockApi/CreateComponentRecord` (same host) | Create a **new** record. **Undocumented** — only an auto-generated Swagger stub exists. Payload shape in `buildRoomTypeRecordPayload()` was reverse-engineered from a real existing record's JSON shape. Top-level `componentName` must be the **display name** (`"Room Type"`), not the alias (`"room-type"`) — the alias fails with `"Component doesn't exists"`. | `src/clients/miblockCreateClient.js` |
| `POST /web/prd/api/property/GetWebContent` (`api-gateway.redistay.com`) | Reference data (rooms, amenities, gallery, thumbnail). Requires `Ocp-Apim-Subscription-Key` header and `Device: "Web"` in the body (required field). | `src/clients/redistayClient.js` |
| `POST /api/v2.0/dam/searchassets` (`damapi.milestoneinternet.com`) | Search DAM for the real asset URL matching a reference-API filename. Read-only. | `src/clients/damClient.js` |

### Auth

- **CMS** (`CMS_BEARER_TOKEN`): the `mscmswt` cookie value after logging into the CMS at
  `redroof.cms.milestoneinternet.info`. Also grab `ASP.NET_SessionId` → `CMS_SESSION_COOKIE`.
  Expires ~24h (`nbf`→`exp` is exactly 86400s in the JWT). `CMS_CLIENT_APP=ProgrammingApp`.
- **DAM** (`DAM_BEARER_TOKEN`): the `access_token` inside the `.Mim.Asgard.Cookie.Production`
  cookie (URL-decode it, it's a JSON blob) after logging into the Asgard app
  (`app.milestoneinternet.com`). Also ~24h expiry.
- **RediStay** (`REDISTAY_SUBSCRIPTION_KEY`): static key, doesn't expire (as far as we know).
- All of these go in `.env` (gitignored). See `.env.example` for the shape.
- When a token expires, re-extract it via browser DevTools → Network tab → any authenticated
  request → `Authorization` header / cookie value. There is no programmatic login flow we know of.

## Key IDs (Red Roof site)

- CMS `SiteId`: **17677**
- DAM `BusinessId`: **7976** (`DAM_BUSINESS_ID` in `.env`)
- Component MiBlockIds: `property-data`=20132, `property-level-gallery`=20133, `room-type`=20135
  (these are shared across every property — only `RecordId`/`ParentRecordId` differ per property)

## DAM folder & filename conventions

- Each property's photos live at `red-roof/<propertycode-lowercase>/siteimages/` (e.g.
  `red-roof/rri207/siteimages/`).
- Filenames are `<property-number>-<description>[-<variant>].jpg` (e.g.
  `207-superior-king-2.jpg`). The **display name** (`name` field in DAM search results) keeps
  spaces/capitals (`"207-superior king 2.jpg"`); the **alias**/path (`alias`, last segment of
  `path`/`assetPath`) is the hyphenated, URL-safe version. **Always match on `alias`, not `name`.**
- Text-searching the property code itself (`"RRI207"`) does **not** hit the folder — but the
  **numeric part** of the code (`"207"`) does, since every filename is prefixed with it. This is
  how `listPropertyImages()` discovers a property's folder contents in one call.
- `findPropertyImageAsset(propertyCode, fileName)` in `damClient.js` does exact-alias match first,
  falls back to fuzzy token-overlap matching (threshold 0.6) scoped to that property's own images
  only, returns `null` (never guesses) if nothing clears the bar.

## Standing business rules (confirmed with the user — do not deviate without asking)

1. **`room-images`: exactly one image per room**, taken from the reference API's specific
   `RoomImageImgUrl` / `ThumbnailImage.Image.FileName` for that room — **not** all DAM variants for
   that room (we built and then explicitly reverted a "grab the whole photo family" version;
   the single-image rule is final).
2. **`listing-page-image` and `gallery-images`: always refreshed**, never skipped just because a
   value already exists (unlike `room-images`, which skips if already populated — see below).
   Source: `ImageGallery[0]` from the reference API for the listing image; every `ImageGallery[]`
   entry, categorized, for the gallery.
3. **`room-images` skip-if-populated**: if an existing CMS room-type record already has ≥1 image,
   leave it alone (`skip-already-has-image`). Only empty ones get updated.
4. **Gallery categorization** (`Exterior` / `Interior` / `Rooms`) is inferred from
   `AlternateText`/`Caption` keywords (no explicit category field in the reference API) — see
   `classify()` in `galleryPlan.js`. Bathroom photos (contain "bath") → `Interior`, even if the alt
   text also mentions a room name like "Superior King" — confirmed with the user.
5. **Alt-text is out of scope for this automation.** `UpdateMiblockRecordAsset` only accepts URLs,
   not alt-text, so it can't be set on existing records this way. It will be added from the CMS
   side manually/separately. Don't try to solve this here.
6. **Duplicate-safety**: before creating a room-type record, check
   `createdRegistry.js` (built from `output/action-log.jsonl`) in addition to the live CMS read —
   `GetComponentData` has been observed to lag well behind CMS admin for records just created (root
   cause unknown; manually confirmed in CMS admin that the records ARE correctly parented, so it's
   a read-side lag, not a write-side bug). **Never rely on `GetComponentData` alone to decide
   "does this already exist" for something we may have just created.**
   - **This lag can get worse, not just "the newest record is missing."** On `RRI656`, after 5
     `room-type` creates + several asset updates in quick succession, `GetComponentData`'s nested
     `ChildRecords` started returning **zero** `room-type` records for that property — including
     `ND2FM`/`NR1KM`, two records that pre-existed this project and were never touched. Manually
     confirmed in CMS admin that all 7 records (old + new) are correctly present and parented — so
     this was 100% a read-side/indexing issue, not data loss, but it means a heavily-written
     property can temporarily go fully blind to this specific query, not just its newest record.
     **When you need ground truth on a property's current state (not just duplicate-avoidance),
     ask the user to check CMS admin directly rather than trusting `GetComponentData`.**
7. **9 property-codes have two legitimate `property-data` records in CMS** (not a data error —
   confirmed with the user), e.g. `HTS1066`, `TRC1210`, `RRI387`, `RRI673`, `HTS1044`, `HTS1060`,
   `RRI1082`, `RRI121`. Every plan builder already loops over **all** `MainFilterObj` entries per
   property code, so this is handled — but a final decision on whether both records should always
   get filled (vs. just the "primary" one) is still open/deferred.

## Known gaps / open items

- **Per-image `AssetAltText`** is never set (see rule 5). Room-type records created by us do get a
  record-level `room-images-alt` **text** field (via `CreateComponentRecord`'s `RecordJsonString`),
  but that's a different, possibly-unused field from the per-image alt text nested in each
  `room-images[]` entry — unconfirmed which one the frontend actually renders.
- **Full rollout not done.** Only `RRI207` and `RRI656` have been run end-to-end (listing + gallery
  + room-type). `output/property-codes.json` has all 712 property codes; `batchAnalyze.js` exists
  for room-type-only dry-run analysis at scale but hasn't been re-run since listing/gallery were
  added, and no batch **write** run has happened yet. Do small batches, not all 712 at once.
- **`CreateComponentRecord` payload is guessed.** Several fields in
  `buildRoomTypeRecordPayload()` (`ComponentLevel`, `Offset`, `ProfileCouponMapping`, etc.) were
  copied verbatim from an existing record with unknown purpose — they work, but "why" is unknown.
  `DisplayOrder`, `CreatedBy`/`UpdatedBy`, `StartDate`/`EndDate` are omitted entirely (left to
  server defaults) — unverified whether that's fine at scale (e.g. does every new record land at
  the same `DisplayOrder` and mess up ordering?).
- **No delete/rollback API yet** — the user said they'll provide one later. Until then, treat every
  create as permanent; double-check payloads before firing.
- **Token expiry mid-batch** — both CMS and DAM tokens are ~24h personal-session tokens. A long
  batch run could outlive them. User said not to worry about this for now, but a real batch runner
  should handle re-auth or at least fail loudly and resumably.

## Logs (property-code-wise, durable, append-only)

- `output/action-log.jsonl` — every `createComponentRecord` / `updateMiblockRecordAsset` call ever
  made, with the full request and response. This is the audit trail **and** the duplicate-safety
  registry (`createdRegistry.js` reads it). Never delete or hand-edit this file.
- `output/no-image-matches.jsonl` — every case where a reference-API image had no DAM match, with
  `propertyCode`, `component` (`room-images`/`listing-page-image`/`gallery-images`), `identifier`
  (room code or gallery category), `fileName`, `reason`. Run
  `summarizeNoMatchesByProperty()` (`src/noMatchLog.js`) to regenerate
  `output/no-image-matches-by-property.json`, a property-code-grouped view for human review.

## File map

```
src/
  clients/
    cmsClient.js            GetComponentData (read)
    redistayClient.js       GetWebContent (reference, read)
    damClient.js             DAM search + fuzzy matching (read)
    miblockWriteClient.js    UpdateMiblockRecordAsset (write, asset fields on existing records)
    miblockCreateClient.js   CreateComponentRecord (write, new records) + payload builder
  planForProperty.js         room-type plan builder (create/update/skip decisions)
  listingImagePlan.js        listing-page-image plan builder (always-refresh)
  galleryPlan.js              property-level-gallery plan builder (always-refresh, categorized)
  createdRegistry.js          reads action-log.jsonl -> Set of already-created room-types
  noMatchLog.js                records/summarizes DAM no-match cases
  actionLog.js                  the append-only write-audit logger
  analyze.js                    CLI: `node src/analyze.js <propertyCode>` - room-type plan only, read-only
  batchAnalyze.js                CLI: room-type plan across all of output/property-codes.json, read-only
  parsePropertyList.js            one-off: parsed data/property-codes-raw.txt into output/property-codes.json
  index.js                         CLI: raw dual-fetch dump (early scaffold, still works, mostly superseded)
  testRRI656.js                     one-off script used for the first full multi-component test run
data/property-codes-raw.txt   raw copy-pasted CMS property listing (source of the 712 codes)
output/                       all generated data - plans, logs, property list. Gitignored.
```

## How to run things

```bash
npm install
cp .env.example .env   # then fill in tokens - see Auth section above

# Room-type plan for one property (read-only)
node src/analyze.js RRI207

# Room-type plan across all 712 properties (read-only)
node src/batchAnalyze.js

# Listing-image / gallery plans - no CLI yet, import and call directly:
node -e "import('./src/listingImagePlan.js').then(m => m.buildListingImagePlan('RRI207')).then(console.log)"
node -e "import('./src/galleryPlan.js').then(m => m.buildGalleryPlan('RRI207')).then(console.log)"
```

**There is no single "run everything for one property, writes included" script yet** — the
RRI207/RRI656 test runs were done as one-off inline `node -e` scripts per component, following the
plan output. If you build one, wire in `recordNoMatch`/`logAction` (already automatic inside the
clients) and make it re-check `buildPlanForProperty`/`buildListingImagePlan`/`buildGalleryPlan`
fresh right before writing, per the duplicate-safety rule above.

## Working agreement with the user (important)

- **Never call a write API (`updateMiblockRecordAsset`, `createComponentRecord`) without the
  user's explicit go-ahead for that specific action.** This was raised firmly once already in this
  project — re-read that as: confirm scope before executing, don't chain extra writes onto an
  approved one.
- Production only, no staging environment is in use for this project.
- Prefer small, reviewable batches over large blind runs.
