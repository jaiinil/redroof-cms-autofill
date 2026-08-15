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
| `POST /api/ComponentApi/DeleteComponentRecord` (same host as CMS) | Deletes one or more records. **Undocumented**, PERMANENT (no known undo). `{ ComponentIds: "<miBlockId>", DeleteIDs: "<id1,id2,...>", SiteId: 17677 }` — both ID fields are comma-joined strings despite the singular-sounding names. | `src/clients/miblockDeleteClient.js` |
| `GET /api/ProfileAPI/Get` (same host as CMS) | Returns **every** property's Profile record in one call (`{ ProfileUnap: [...] }`), each with `ProfileId` + `PropertyCode` — this is the map used to link a room-type record to its property's Profile (see the standing rule below). No query params needed, just auth headers. Cached per-process in `profileClient.js`. | `src/clients/profileClient.js` |

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
8. **A `room-type` record MUST carry its property's Profile, or it doesn't show up correctly** (CMS
   admin's manual "Add Component Record" form has an "Advance Configuration → Select Profile" field;
   user confirmed a room type only shows in the UI once a profile is selected there). Discovered
   *after* the whole 712-property room-type wipe (see below) — every room-type record created before
   this fix landed had no Profile link and needs to be recreated.
   - **Get the ID**: `GET /api/ProfileAPI/Get` → find the entry where `PropertyCode` matches, use its
     `ProfileId` (`profileClient.js`'s `getProfileIdForPropertyCode()`).
   - **Set it on create**: two earlier guesses were wrong and confirmed wrong in CMS admin
     (`SelectedProfiles` alone on `CreateComponentRecord`; a `ProfileId` scalar + `Profile: [{ProfileID}]`
     array). The fix, confirmed working on RRI207, was capturing CMS admin's own real save request
     (a *different* endpoint, `POST /ccadmin/cms/Component/SaveComponentRecord` — admin-panel-internal,
     not `/api/MiblockApi/...`) and copying its companion fields onto our existing
     `CreateComponentRecord` call: `SelectedProfiles` **and** `PreviousAssignProfileIds` (both the
     stringified `ProfileId`), plus `MainParentComponentId` **and** `ParentComponentId` (both the
     *parent* component's MiBlockId — `20132` for a `room-type` whose parent is `property-data` —
     not the room-type's own `20135`). All four together were needed; `SelectedProfiles` alone was not
     enough. See `buildRoomTypeRecordPayload()` in `miblockCreateClient.js`.
   - The real `/ccadmin/cms/Component/SaveComponentRecord` endpoint itself was captured but never
     adopted — the user chose to keep using `CreateComponentRecord` with the borrowed fields instead.
     It's worth revisiting if another undocumented gap shows up (it appeared to accept a `RecordId`
     for an *existing* record too, which could be the missing "update text fields on an existing
     record" API this project has wanted since the alt-text/`api-unique-id` gaps — see below). Full
     headers (auth method, Content-Type, anti-forgery token) were never captured, so treat it as
     unexplored, not ruled out.

## Known gaps / open items

- **Per-image `AssetAltText`** is never set (see rule 5). Room-type records created by us do get a
  record-level `room-images-alt` **text** field (via `CreateComponentRecord`'s `RecordJsonString`),
  but that's a different, possibly-unused field from the per-image alt text nested in each
  `room-images[]` entry — unconfirmed which one the frontend actually renders. The captured
  `SaveComponentRecord` endpoint (rule 8) might be the real fix path for this too, if revisited.
- **`CreateComponentRecord` payload still has guessed fields.** Several fields in
  `buildRoomTypeRecordPayload()` (`ComponentLevel`, `Offset`, `ProfileCouponMapping`, etc.) were
  copied verbatim from an existing record with unknown purpose — they work, but "why" is unknown.
  `DisplayOrder`, `CreatedBy`/`UpdatedBy`, `StartDate`/`EndDate` are omitted entirely (left to
  server defaults) — unverified whether that's fine at scale.
- **Token expiry mid-batch** — both CMS and DAM tokens are ~24h personal-session tokens. A long
  batch run could outlive them; the batch scripts don't handle re-auth, they just fail loudly.
  Restart the batch from wherever it stopped after refreshing `.env`.
- **`UpdateMiblockRecordAsset` can return `Success: true` and write nothing.** Confirmed on
  `property-data` (`listing-page-image`, MiBlockId 20132) and `property-level-gallery`
  (`gallery-images`, 20133) records on 2026-08-15. **`Success: true` is NOT proof a write landed.**
  - **How to actually verify a write**: read the record back and compare its `updateddate` against
    your write timestamp. A landed write matches to within milliseconds (confirmed on room-type
    record 221688: write at `03:24:05.269Z`, `updateddate` `03:24:05.25`). A silent no-op leaves
    `updateddate` untouched — the failing gallery records still read `2026-07-03T07:30:20.36`, their
    bulk-template creation date, identical across unrelated properties.
  - **Not a read-lag, not the token, not an outage**: room-type creates and `room-images` updates
    made the same night, minutes apart, on the same token, all landed and read back immediately.
  - **It is not permanently broken either**: the same call on the same gallery record (157748,
    HTS1018) landed on 2026-08-14 at 13:22 and silently no-opped on 2026-08-15 at 03:36. Both
    requests were byte-identical (same MiBlockId, RecordId, asset URL) with byte-identical
    responses.
  - **Metadata gives no clue**: a record where the write lands (157748) and one where it doesn't
    (158898) are identical on `ComponentId`, `RecordIsEditable`, `IsProtected`, `IsVisible`,
    `ProfileCount`/`Profiles`, `LanguageId`, `HasLocalChanges` and all date fields.
  - Cause unknown. Untested leads: whether the target field having **no existing value** matters
    (every confirmed landing was on a record that already had a value, or a room-type record we had
    just created); a server-side rate/quota effect after thousands of writes; and the
    `POST /ccadmin/cms/Component/SaveComponentRecord` endpoint noted in rule 8, which is the path
    CMS admin itself uses and remains unexplored.
- **Leading-zero property codes have no DAM folder at all** — e.g. `RRI030`'s photos are not at
  `red-roof/rri030/siteimages/`, and no `rri30`-without-the-zero folder exists either (verified by
  scanning 500 assets for both spellings). Text-searching `"030"` *does* return hits, but they're
  `hts1030` files matching on substring — the path filter in `listPropertyImages()` correctly
  rejects them, so no wrong image is ever written; those properties just get records with no image.
  **64 of the 712 codes are leading-zero**, and they account for the bulk of the 530 unmatched
  gallery images (79 properties). This is a DAM content gap, not a matcher bug — once the photos are
  uploaded, re-running `listingGalleryBatch.js` will fill them in (it's update-only).
- **`GetComponentData` can transiently return empty results under load, not just lag on recent
  writes** — a 500-property batch (concurrency 5) saw ~43% of properties come back with `TotalCount:
  0` / no `MainFilterObj`, and every single one succeeded on retry. Root cause unconfirmed (backend
  load, not real absence). All batch scripts (`deleteAllRoomTypesBatch.js`,
  `recreateAllRoomTypesBatch.js`) now retry up to 3x with backoff before concluding "no property
  record" — don't remove that without re-confirming the underlying issue is gone.

## Logs (property-code-wise, durable, append-only)

- `output/action-log.jsonl` — every `createComponentRecord` / `updateMiblockRecordAsset` /
  `deleteComponentRecord` call ever made, with the full request and response. This is the audit
  trail **and** the duplicate-safety registry (`createdRegistry.js` reads it — also exposes
  `loadCreatedRecordIdsForParent()`, used to build a complete delete-target list that a lagging read
  API might otherwise miss records from). Never delete or hand-edit this file.
- `output/no-image-matches.jsonl` — every case where a reference-API image had no DAM match, with
  `propertyCode`, `component` (`room-images`/`listing-page-image`/`gallery-images`), `identifier`
  (room code or gallery category), `fileName`, `reason`. Run
  `summarizeNoMatchesByProperty()` (`src/noMatchLog.js`) to regenerate
  `output/no-image-matches-by-property.json`.
- `output/no-reference-data.jsonl` — properties where RediStay's `GetWebContent` returned no
  `RoomDetails` at all (nothing to create room-types from). `summarizeNoReferenceDataByProperty()`
  (`src/noReferenceDataLog.js`) → `output/no-reference-data-by-property.json`.
- `output/completed-properties.jsonl` — simple processed/not-processed progress tracker across batch
  runs (property code + outcome status + timestamp), separate from the full-detail master files
  below. `summarizeCompletedProperties()` (`src/completedPropertiesLog.js`) →
  `output/completed-properties-list.json`.
- `output/deleted-room-types-by-property.json`, `output/recreated-room-types-by-property.json` and
  `output/listing-gallery-by-property.json` — running, property-code-keyed master summaries written
  directly by `deleteAllRoomTypesBatch.js`, `recreateAllRoomTypesBatch.js` and
  `listingGalleryBatch.js` respectively (merge-on-write, not append-only like the `.jsonl` logs).
  - **Caveat**: a property fixed by a one-off single-property re-run (rather than by a batch) will
    still show its old `error` status here, because those re-runs deliberately skip the master-file
    rewrite to avoid clobbering a concurrently running batch. `action-log.jsonl` and
    `completed-properties.jsonl` are the truth for those. Known stale entries: `RRI1110`, `RRI1111`,
    `RRI111`, `RRI403`, `RRI404` — all five are actually fixed.

## File map

```
src/
  clients/
    cmsClient.js            GetComponentData (read)
    redistayClient.js       GetWebContent (reference, read)
    damClient.js             DAM search + fuzzy matching (read). listPropertyImages() caches per
                              property per-process - findPropertyImageAsset() is called once per
                              image, so an 11-image gallery would otherwise re-page the same folder
                              11 times (measured: 5.8s -> 0ms on hit; gallery plan 60s -> 3s)
    miblockWriteClient.js    UpdateMiblockRecordAsset (write, asset fields on existing records)
    miblockCreateClient.js   CreateComponentRecord (write, new records) + payload builder
    miblockDeleteClient.js    DeleteComponentRecord (write, PERMANENT)
    profileClient.js           ProfileAPI/Get (read) -> PropertyCode -> ProfileId lookup
  planForProperty.js         room-type plan builder (create/update/skip decisions) - PRE-DATES the
                              Profile-linking fix (rule 8); if reused, wire profileId through it
  listingImagePlan.js        listing-page-image plan builder (always-refresh)
  galleryPlan.js              property-level-gallery plan builder (always-refresh, categorized)
  createdRegistry.js          reads action-log.jsonl -> created-room-type Set + per-parent record IDs
  noMatchLog.js                records/summarizes DAM no-match cases
  noReferenceDataLog.js         records/summarizes "no RediStay room data" cases
  completedPropertiesLog.js      simple batch-progress tracker (processed vs not, per property)
  actionLog.js                    the append-only write-audit logger
  analyze.js                      CLI: `node src/analyze.js <propertyCode>` - room-type plan only, read-only
  batchAnalyze.js                  CLI: room-type plan across all of output/property-codes.json, read-only
  deleteAndRecreateRoomTypes.js      CLI: delete+recreate room-types for ONE property (single-property
                                     version of the batch script below; predates the Profile-linking
                                     fix - buildRoomTypeRecordPayload() call in here needs profileId
                                     added if this script is used again)
  deleteAllRoomTypesBatch.js          CLI: `node src/deleteAllRoomTypesBatch.js <startIndex> <batchSize>`
                                       - deletes room-types for a slice of property-codes.json, PERMANENT,
                                       already run across all 712 (see status below)
  recreateAllRoomTypesBatch.js         CLI: `node src/recreateAllRoomTypesBatch.js <startIndex> <batchSize>`
                                        - the CURRENT full pipeline: clears any leftover room-type
                                        records for a property, then recreates fresh from RediStay with
                                        Profile linking + one DAM-matched image each. THIS is the script
                                        to run/resume the 712-property rollout with.
  listingGalleryBatch.js               CLI: `node src/listingGalleryBatch.js <startIndex> <batchSize>`
                                        - applies listing-page-image + property-level-gallery for a
                                        slice. Update-only (both fields are always-refresh, rule 2),
                                        so no delete/create and nothing permanent - safe to re-run.
                                        Already run across all 712 (see status below).
  parsePropertyList.js            one-off: parsed data/property-codes-raw.txt into output/property-codes.json
  index.js                         CLI: raw dual-fetch dump (early scaffold, still works, mostly superseded)
  testRRI656.js                     one-off script used for the first full multi-component test run
data/property-codes-raw.txt   raw copy-pasted CMS property listing (source of the 712 codes)
output/                       all generated data - plans, logs, property list. Gitignored.
```

## Current rollout status (update this section as batches complete)

1. **All 712 properties' `room-type` records were deleted** (`deleteAllRoomTypesBatch.js`, 3 batches:
   0–100, 100–600, 600–712) — 1282 records removed, 0 errors, 0 unresolved "no property record" cases
   (all initial "missing" ones were the transient-empty-response issue above, confirmed via retry).
2. **Room-type recreation is COMPLETE for all 712** (`recreateAllRoomTypesBatch.js`), with Profile
   linking on every record. Batch `0–100` was done in a separate session (99 OK, `HTS1031` has no
   RediStay room data). Batches `100–200`, `200–600`, `600–712` were run here: **~4,100 rooms
   created, ~3,780 images linked (~92%)**, plus 7 `no-reference-rooms` properties (RediStay returns
   no `RoomDetails` — not an error).
   - 5 properties errored mid-batch on transient network/JSON faults and were left **partially
     populated** (some rooms created, rest missing). All 5 were re-run individually and verified to
     match their reference room count exactly: `RRI1110`, `RRI1111`, `RRI111`, `RRI403`, `RRI404`.
     **A mid-property failure always leaves a partial property — re-run that property, don't assume
     the batch's per-property status is atomic.**
3. **`listing-page-image` + `property-level-gallery`: the batch RAN but the writes DID NOT LAND.**
   `listingGalleryBatch.js` was run across all 712 (batches 0–50, 50–150, 150–300, 300–500,
   500–712) and reported 712 OK / 0 errors / 642 listing images / 4,705 gallery images — every call
   returned `Success: true`. **None of it persisted.** See the known gap below; this rollout needs
   redoing once the cause is found. Do not trust the batch's own summary as evidence of success.
4. **Total audit trail: 10,520 write calls, zero `Success: false`, zero corrupt log lines.**
5. **Known unverified item**: on `HTS1030` all 4 writes returned `Success: true`, but
   `GetComponentData` still read back empty on two separate re-reads minutes apart. Consistent with
   the documented read-lag (rule 6) and with the fact that no write in 10,520 calls was rejected —
   but **not confirmed in CMS admin**. Worth a spot-check.
6. Branches: work happens on `jainil-develop` and `vishal-develop`; **`main` is not touched**, per
   explicit instruction. `output/` is gitignored, so each person's progress files aren't visible to
   the other — share status separately before assuming a range is untouched.

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

**Room-type rollout (writes, PERMANENT, this is the live in-progress task — see status above):**

```bash
# Recreates room-types for properties at index [start, start+size) of output/property-codes.json.
# Deletes any leftover room-type records first, then creates fresh from RediStay + links one DAM
# image each, with Profile linking. Prints a per-batch summary and updates
# output/recreated-room-types-by-property.json + output/completed-properties-list.json.
node src/recreateAllRoomTypesBatch.js <startIndex> <batchSize>

# e.g. to continue after 0-100 is done:
node src/recreateAllRoomTypesBatch.js 100 500
node src/recreateAllRoomTypesBatch.js 600 112
```

Check the printed summary's `Errors` count after every batch before moving to the next slice. If a
property comes back `no-property-record`, that was historically a transient `GetComponentData`
issue (see Known gaps) already retried 3x internally — if it's still failing after a fresh
manual re-check, something's actually wrong, don't just re-run blindly.

**Listing-image + gallery rollout (writes, update-only — safe to re-run):**

```bash
# Applies listing-page-image and all 3 property-level-gallery tabs for a slice.
# Both fields are always-refresh (rule 2), so this only ever calls
# updateMiblockRecordAsset - no creates, no deletes, nothing permanent.
node src/listingGalleryBatch.js <startIndex> <batchSize>
```

## Working agreement with the user (important)

- **Never call a write API (`updateMiblockRecordAsset`, `createComponentRecord`) without the
  user's explicit go-ahead for that specific action.** This was raised firmly once already in this
  project — re-read that as: confirm scope before executing, don't chain extra writes onto an
  approved one.
- Production only, no staging environment is in use for this project.
- Prefer small, reviewable batches over large blind runs.
