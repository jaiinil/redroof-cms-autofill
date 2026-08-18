# redroof-cms-autofill

Automation that fills gaps in the Red Roof CMS (Milestone MiBlock) by cross-referencing the
RediStay reference API and matching real DAM assets — per property.

> For full technical context (API shapes, field mappings, standing business rules, and every gap/
> gotcha found along the way), see [`CLAUDE.md`](./CLAUDE.md). This file is the practical "how do
> I run this" guide.

## Status: the initial rollout is done

`listing-page-image`, `property-level-gallery` (Exterior/Interior/Rooms), and `room-type` records
have already been filled/recreated for all 712 properties, verified by re-reading written vs. read
counts. See `CLAUDE.md`'s "Current rollout status" section for the exact numbers and what's left
(a handful of properties have real content gaps — no DAM folder, or no RediStay room data — that no
amount of automation can fix; they need photos/data added at the source).

What you'll normally be doing now is **maintenance**: filling a property once new DAM photos land,
or re-checking coverage. The historical wipe-and-rebuild scripts are still here and still work, but
you shouldn't need them unless something gets deleted or a new property is added.

## 1. Setup

```bash
git clone https://github.com/jaiinil/redroof-cms-autofill.git
cd redroof-cms-autofill
git checkout jainil-develop   # or vishal-develop - main is not used for this project
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

⚠️ **Both `CMS_BEARER_TOKEN` and `DAM_BEARER_TOKEN` expire after ~24 hours** — and a DAM token has
been seen to die early too (re-logging into Asgard revokes the previous one). If calls start
returning 401 mid-batch, re-extract and restart from wherever it stopped.

⚠️ **Everything in this project talks to production. There is no staging environment.** Creates
and deletes are permanent — there is a delete API (`DeleteComponentRecord`), but no "undo" beyond
calling it deliberately yourself. Read `CLAUDE.md`'s "Working agreement with the user" section
before running anything that writes.

## 2. Check current coverage (safe, read-only)

```bash
# Fast pass: per-property counts of listing/gallery/room images
node src/coverageScan.js
# -> output/image-zero-report.{json,csv}

# Fuller pass: also lists every individual room-type record's own image count
node src/inventoryScan.js
# -> output/consolidated-report.{json,csv}, output/consolidated-rooms.csv

# Turn the inventory scan into a browsable HTML table (run inventoryScan.js first)
node src/inventoryReport.js
# -> output/image-inventory.html
```

Both scans retry a few times on empty reads before reporting a property as having "no record" —
`GetComponentData` can return empty transiently under load or lag behind a very recent write by
**hours** (see `CLAUDE.md`'s Known Gaps). Don't treat a single scan's zero as proof of a real gap
without re-checking.

## 3. Fill a single property (the normal day-to-day task)

Once new DAM photos land for a property (or you just want to (re-)apply everything to one code),
this is the one command that does listing + gallery + room-images together:

```bash
node src/fillPropertyBatch.js RRI030 RRI031
# or: node src/fillPropertyBatch.js --file output/some-codes.json
```

This is **update-only** — it fills empty fields and refreshes listing/gallery, but never creates
or deletes a record. If a property needs a room-type record that doesn't exist yet, it's reported
in the output (`CREATES-NEEDED`) rather than created, because creating one requires the Profile
wiring described in `CLAUDE.md` rule 8 — see §5 below if you actually need to create one.

Gallery images in this script are sourced straight from the property's DAM folder (categorized by
filename), not from the RediStay reference feed — see `CLAUDE.md` rule 4 for why that changed.

## 4. Batch-run across many properties

The same three things, at scale — useful after a bulk DAM upload or when re-verifying a large
range. All of these are resumable: pass a start index and a batch size against
`output/property-codes.json`.

```bash
# Listing + gallery, reference-feed sourced, update-only (safe to re-run)
node src/listingGalleryBatch.js <startIndex> <batchSize>

# Gallery re-filled straight from the DAM folder (update-only, safe to re-run)
node src/damGalleryBatch.js <startIndex> <batchSize>
```

Check the printed summary's error count after every batch before moving to the next slice.

## 5. Creating room-type records (rare — only if something's missing)

This is the one **permanent** operation in this project. `recreateAllRoomTypesBatch.js` deletes
any leftover room-type records for a property and recreates them fresh from RediStay with Profile
linking + one DAM-matched image each:

```bash
node src/recreateAllRoomTypesBatch.js <startIndex> <batchSize>
```

Only reach for this if `coverageScan.js`/`inventoryScan.js` shows a property genuinely missing
room-type records (not just missing images on existing ones — that's §3/§4's job). Read
`CLAUDE.md` rule 8 in full before touching `buildRoomTypeRecordPayload()` — the Profile-linking
fields are not optional; a record created without them silently doesn't show correctly in CMS
admin.

## 6. Logs and audit trail

Every write call (`create`, `update`, `delete`) logs itself automatically to
`output/action-log.jsonl` — nothing extra to do for that. See `CLAUDE.md`'s "Logs" section for the
full list of what's tracked and how to regenerate the property-grouped summaries
(`no-image-matches`, `no-reference-data`, `completed-properties`, etc.). All of `output/` is
gitignored, so **share status with your collaborator explicitly** — their local progress files
aren't visible to you and vice versa.

## 7. Regenerating the property code list

`output/property-codes.json` (712 codes, deduplicated/case-normalized) is generated from
`data/property-codes-raw.txt` via:

```bash
node src/parsePropertyList.js
```

Re-run this only if you have a fresher property listing to paste into
`data/property-codes-raw.txt` — it also flags duplicate/conflicting codes on the way
(`output/property-codes-flagged.json`).
