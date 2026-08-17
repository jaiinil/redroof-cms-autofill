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
   - **`listing-page-image` source is `ThumbnailImage.Image.FileName`** (user-confirmed 2026-08-17,
     replacing the earlier `ImageGallery[0]`; `ImageGallery[0]` remains a fallback when a property
     has no `ThumbnailImage`). **The two do not always agree** — on `HTS1437` `ThumbnailImage` is a
     jetted-tub room shot while `ImageGallery[0]` was the twilight exterior, so this change moved
     some properties' hero image from an exterior to a room.
   - **`gallery-images` source is every `ImageGallery[].Image.FileName`**, categorized.
   - In both cases the reference feed only **names** the file; the URL written is always the DAM
     asset found for that name. The feed's own `Image.Url` / `Image.otherSources.original`
     (`images.redroof.com`) **are accepted by the CMS** — verified — but using them would put part
     of the estate on a different host, so DAM stays the source of URLs.
3. **`room-images` skip-if-populated**: if an existing CMS room-type record already has ≥1 image,
   leave it alone (`skip-already-has-image`). Only empty ones get updated.
4. **Gallery categorization** (`Exterior` / `Interior` / `Rooms`) is inferred from
   `AlternateText`/`Caption` keywords (no explicit category field in the reference API) — see
   `classify()` in `galleryPlan.js`. Bathroom photos (contain "bath") → `Interior`, even if the alt
   text also mentions a room name like "Superior King" — confirmed with the user.
   - **SUPERSEDED for gallery by `damGalleryBatch.js` (user-approved 2026-08-17).** The reference
     feed proved too thin a source: it is a smaller subset than the DAM folder, and its alt-text
     frequently classified nothing as `Exterior`, leaving that tab empty on 48 properties whose DAM
     folders held exterior shots all along. `damGalleryBatch.js` sources from the DAM folder and
     categorises on the FILENAME instead. Bath-beats-room-name still holds. It also filters
     `-delete` (retired) and `sign-off` (signage) assets, strips the "HomeTowne Studios" brand token
     so a ballroom shot doesn't land in `Rooms`, and takes one image per room family before
     backfilling variants so five different room types show rather than five angles of one.
     **Applied to ~210 properties; the rest still carry reference-sourced galleries**, so the two
     sourcing methods currently coexist across the estate.
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
7. **RESOLVED (2026-08-17): there are no longer any duplicate `property-data` records.** There used
   to be 8 property codes with two records each (`HTS1044`, `HTS1060`, `HTS1066`, `HTS1072`,
   `RRI1082`, `RRI121`, `RRI387`, `RRI673`) — in every case the newer record (id ~172xxx) carried
   room-types but no `property-level-gallery` records at all. The user deleted all 8 duplicates in
   CMS admin; the surviving record is the older, fully-populated one. A scan of all 712 codes now
   returns exactly one `property-data` record each. Plan builders still loop over every
   `MainFilterObj` entry, which is correct and costs nothing — don't remove that.
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
- **`GetComponentData` lags MULTIPLE HOURS for `property-data` and `property-level-gallery` — and
  the lag is total, not partial.** After the listing/gallery batch, affected records read back as if
  nothing had happened: `gallery-images` **absent from `Data` entirely** (not an empty array), and
  `updateddate` still showing `2026-07-03T07:30:20.36`, the bulk-template creation date, identical
  across unrelated properties. ~2 hours later every one of them read back correctly, with
  `updateddate` matching the write timestamp to the millisecond. **Nothing was wrong; the read was
  just hours stale.**
  - **`updateddate` is NOT a reliable freshness check here** — it is served from the same stale view
    and lags with everything else. This was learned the hard way: a whole 712-property rollout was
    wrongly declared failed on exactly that evidence, and the wrong conclusion was committed to this
    file before the reads caught up.
  - **Intermediate/partial states are visible while it catches up.** HTS1018's Interior tab was
    written with 4 images but read back as 3 mid-catch-up. Anything that reads-then-writes during
    that window will cement the partial state — a "restore what was there" step read 3, wrote 3, and
    silently dropped the 4th image. **Never round-trip (read → modify → write) these components
    without knowing the read is settled.**
  - **The lag is component-specific.** `room-type` creates and `room-images` updates made the same
    night, minutes apart, on the same token, read back immediately and correctly. Only 20132/20133
    showed the multi-hour delay.
  - **How to actually verify a batch**: wait a few hours, then re-read and compare written vs read
    counts per property. `Success: true` alone is not proof, but neither is an immediate empty read
    proof of failure — the only trustworthy check is a settled read, or CMS admin.
- **`UpdateMiblockRecordAsset` used to cap every asset field at 5 assets — LIFTED 2026-08-17.**
  Sending 6+ failed the FIELD (`"Number of AssetUrls exceeds the maximum limit of 5 for field alias
  <alias>"`, `Success: false` in `UpdateMiBlockRecordStatuses`) while the **top-level `Success`
  stayed `true`** — so a caller checking only the top-level flag recorded a success and left the tab
  empty. That silently lost **170 tabs across 159 properties**. The cap was identical (5) on
  `gallery-images`, `listing-page-image` and `room-images`, i.e. not per-field config; CMS admin
  could save more than 5 while the API refused, which is what pinned it to the API. After Milestone
  lifted it, re-verified by sending 6, 8, 12, 20, 40 and all 57 usable assets of one property to a
  single tab — every one accepted, no new ceiling found. `MAX_GALLERY_IMAGES` is now `Infinity`.
  **The lesson outlives the cap: always check the per-field statuses, never just `body.Success`.**
- **A DAM token can die BEFORE its `exp`.** Mid-batch, 21 properties failed with
  `DAM auth failed` while the JWT still had 6.7 hours left; the API answered `401` with
  `www-authenticate: Bearer error="invalid_token"`. Re-logging into Asgard appears to revoke the
  previous token. **Checking `exp` is not enough — make one live DAM call to confirm a token before
  starting a long batch.** When it happens the damage is contained: the DAM lookup runs before any
  write, so the affected properties get nothing written rather than half-written.
- **Transient failures are normal on every batch and all of them recovered on retry.** Across the
  712-property listing/gallery re-run: 21 DAM `401`s, several `fetch failed`, and several
  `No CMS property-data record found` (the documented transient-empty read). Re-running just the
  failed codes fixed every one. **Treat "re-run the failures" as a required step of any batch, not
  an exception.**
- **`skip-no-cms-record` is not proof a record is missing.** `GetComponentData` can return a
  property record with an empty `ChildRecords` list, then return the same record minutes later with
  all its children. TRC1210 read as having zero `property-level-gallery` records twice, which is why
  the batch skipped all three of its tabs — a full re-scan showed all three present the whole time.
  Confirm with repeated reads (they were stable across 3 reads for the genuinely-missing cases)
  before concluding a record needs creating.
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
  damGalleryBatch.js                   CLI: `node src/damGalleryBatch.js <startIndex> <batchSize>`
                                        - fills property-level-gallery straight from the property's
                                        DAM folder, categorising by FILENAME. Deliberately bypasses
                                        the RediStay reference feed (see rules 2/4 note below).
                                        Exports buildDamGalleryPlan() + applyDamGalleryForProperty()
                                        for single-property use.
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
3. **`listing-page-image` + `property-level-gallery` are COMPLETE for all 712**
   (`listingGalleryBatch.js`, batches 0–50, 50–150, 150–300, 300–500, 500–712): **712 OK, 0 errors,
   642 listing images set, 1,653 gallery tabs filled, 4,705 gallery images linked.** Verified by
   reading records back ~2h later: written count matches read count property by property.
   - **For ~2 hours after the writes, `GetComponentData` showed all of this as empty**, which looks
     exactly like total failure. See the read-lag gap below before concluding a batch did nothing.
   - Properties that legitimately got nothing (`skip-no-dam-image-match`) are a separate DAM content
     gap, not a write problem — see the leading-zero entry below.
4. **Gallery re-filled from DAM on ~210 properties** (`damGalleryBatch.js`): the 155 whose tabs the
   5-asset limit had silently emptied, then 49 more whose `Exterior` tab was empty despite DAM
   holding exterior shots, plus a handful of one-offs. All landed, 0 errors.
5. **Verified end state (full re-read of all 712 on 2026-08-17):** 642 properties have images;
   70 are completely empty (62 have no DAM folder, 8 get no `ImageGallery` from RediStay); 3 are
   partially empty (`RRI635` has 30 DAM photos but none exterior, `RRI553` has one bathroom photo,
   `RRI019` has listing images but no DAM folder). **Nothing is left that automation can fix** —
   every remaining gap needs photos uploaded to DAM or room data added in RediStay.
   Cross-checking written-vs-read found **zero** properties where a write did not land.
   Report: `output/image-zero-report.csv`, `output/full-diagnosis.json`.
6. **Total audit trail: 10,520 write calls, zero `Success: false`, zero corrupt log lines.**
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
