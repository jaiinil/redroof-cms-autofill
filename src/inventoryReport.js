import { readFile, writeFile } from 'node:fs/promises';

const rows = JSON.parse(await readFile('output/consolidated-report.json', 'utf8'));
const PENDING = new Set(['HTS1031', 'RRI079', 'RRI1272', 'RRI1279', 'RRI1426', 'RRI455', 'RRI905', 'TRC1415']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const ok = rows.filter((r) => r.status === 'ok');
const totals = {
  properties: ok.length,
  listing: ok.filter((r) => r.listing > 0).length,
  gallery: ok.reduce((n, r) => n + r.galleryTotal, 0),
  roomRecords: ok.reduce((n, r) => n + r.roomTypeCount, 0),
  roomsWithImage: ok.reduce((n, r) => n + r.roomsWithImage, 0),
};
const gapCount = ok.filter((r) => !PENDING.has(r.code) && (r.listing === 0 || r.galleryTotal === 0 || r.roomTypeCount === 0 || r.roomsWithImage < r.roomTypeCount)).length;

const cell = (v) => (v === null ? '<span class="na">—</span>' : v === 0 ? '<span class="zero">0</span>' : v);

const body = ok.map((r) => {
  const pending = PENDING.has(r.code);
  const hasGap = !pending && (r.listing === 0 || r.galleryTotal === 0 || r.roomTypeCount === 0 || r.roomsWithImage < r.roomTypeCount);
  const roomChips = r.roomDetail.length
    ? r.roomDetail.map((x) => `<span class="rm${x.images ? '' : ' rm-0'}">${esc(x.code)}<i>${x.images}</i></span>`).join('')
    : '<span class="na">no room-type records</span>';
  return `<tr data-code="${esc(r.code).toLowerCase()}" data-gap="${hasGap ? 1 : 0}" data-pending="${pending ? 1 : 0}">
  <td class="mono code">${esc(r.code)}${pending ? '<span class="badge">read pending</span>' : ''}</td>
  <td class="num">${cell(r.listing)}</td>
  <td class="num">${cell(r.exterior)}</td>
  <td class="num">${cell(r.interior)}</td>
  <td class="num">${cell(r.rooms)}</td>
  <td class="num strong">${cell(r.galleryTotal)}</td>
  <td class="num">${r.roomsWithImage}<span class="of">/${r.roomTypeCount}</span></td>
  <td class="rooms">${roomChips}</td>
</tr>`;
}).join('\n');

const html = `<title>Red Roof Image Inventory</title>
<style>
:root{
  --ground:#F6F4F3; --surface:#FFFFFF; --sunk:#EFECEA; --row:#FBFAF9;
  --ink:#1C1817; --ink-2:#4A4340; --ink-3:#7B726D;
  --line:#DDD7D3; --line-2:#C8C0BB;
  --brand:#9E2B2B; --ok:#2F6B57; --act:#1F5C86; --act-bg:#E2EDF5; --gap:#8A6A2F; --gap-bg:#F4ECDC;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#161313; --surface:#1F1B1A; --sunk:#272221; --row:#1B1817;
  --ink:#F1ECEA; --ink-2:#BEB4AF; --ink-3:#8B807A;
  --line:#332D2B; --line-2:#463E3B;
  --brand:#E06B6B; --ok:#7EC4A8; --act:#82B8DD; --act-bg:#1A2833; --gap:#D6B173; --gap-bg:#2E2718;
}}
:root[data-theme="dark"]{
  --ground:#161313; --surface:#1F1B1A; --sunk:#272221; --row:#1B1817;
  --ink:#F1ECEA; --ink-2:#BEB4AF; --ink-3:#8B807A;
  --line:#332D2B; --line-2:#463E3B;
  --brand:#E06B6B; --ok:#7EC4A8; --act:#82B8DD; --act-bg:#1A2833; --gap:#D6B173; --gap-bg:#2E2718;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.mono,.num,.rm{font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.wrap{max-width:1280px;margin:0 auto;padding:44px 24px 80px}
header{border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:28px}
.eyebrow{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--brand);margin:0 0 9px}
h1{font-size:clamp(26px,3.4vw,36px);line-height:1.1;letter-spacing:-.022em;margin:0 0 10px;font-weight:650;text-wrap:balance}
.sub{color:var(--ink-2);margin:0;max-width:70ch}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:0 0 24px}
.stat{background:var(--surface);padding:15px 18px}
.stat .v{font-family:ui-monospace,monospace;font-size:26px;font-weight:600;letter-spacing:-.02em;line-height:1}
.stat .k{font-size:11.5px;color:var(--ink-3);margin-top:7px}
.stat.ok .v{color:var(--ok)} .stat.gap .v{color:var(--gap)} .stat.act .v{color:var(--act)}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
input[type=search]{flex:1;min-width:220px;padding:9px 12px;border:1px solid var(--line-2);border-radius:3px;background:var(--surface);color:var(--ink);font:14px ui-monospace,monospace}
input[type=search]:focus{outline:2px solid var(--act);outline-offset:1px}
button{padding:9px 14px;border:1px solid var(--line-2);border-radius:3px;background:var(--surface);color:var(--ink-2);font:13px inherit;cursor:pointer}
button[aria-pressed="true"]{background:var(--act-bg);color:var(--act);border-color:var(--act)}
button:focus-visible{outline:2px solid var(--act);outline-offset:1px}
.hint{color:var(--ink-3);font-size:12.5px}
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line)}
table{border-collapse:collapse;width:100%;font-size:13px}
thead th{position:sticky;top:0;background:var(--sunk);text-align:left;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);font-weight:600;padding:10px 11px;border-bottom:1px solid var(--line-2);white-space:nowrap;z-index:1}
td{padding:8px 11px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:nth-child(even){background:var(--row)}
tbody tr.hide{display:none}
td.num{text-align:right;color:var(--ink-2);white-space:nowrap}
td.num.strong{color:var(--ink);font-weight:600}
td.code{white-space:nowrap;font-weight:600}
.of{color:var(--ink-3);font-weight:400}
.zero{color:var(--gap);font-weight:700}
.na{color:var(--ink-3)}
.badge{display:inline-block;margin-left:7px;font-family:inherit;font-size:10px;font-weight:500;padding:1px 6px;border-radius:2px;background:var(--act-bg);color:var(--act)}
td.rooms{min-width:280px}
.rm{display:inline-block;font-size:11px;padding:2px 5px;margin:1px 3px 1px 0;background:var(--sunk);border:1px solid var(--line);border-radius:2px;color:var(--ink-2)}
.rm i{font-style:normal;color:var(--ink-3);margin-left:4px}
.rm-0{background:var(--gap-bg);border-color:var(--gap);color:var(--gap)}
.rm-0 i{color:var(--gap)}
.note{border-left:3px solid var(--brand);padding:11px 0 11px 15px;color:var(--ink-2);margin:20px 0 0;font-size:13.5px;max-width:78ch}
.note b{color:var(--ink)}
footer{border-top:1px solid var(--line);margin-top:40px;padding-top:18px;color:var(--ink-3);font-size:12.5px}
code{font-family:ui-monospace,monospace;font-size:.92em;background:var(--sunk);padding:1px 5px;border-radius:2px}
</style>
<div class="wrap">
<header>
  <p class="eyebrow">Red Roof CMS &middot; image inventory</p>
  <h1>Every property, image by image</h1>
  <p class="sub">All ${totals.properties} property codes read back from the CMS: the listing image, each gallery tab, and every individual room-type record with its own image count. Counts are what the CMS returns, not what was written to it.</p>
</header>

<div class="stats">
  <div class="stat ok"><div class="v">${totals.listing}</div><div class="k">listing images set</div></div>
  <div class="stat ok"><div class="v">${totals.gallery.toLocaleString('en-US')}</div><div class="k">gallery images</div></div>
  <div class="stat ok"><div class="v">${totals.roomsWithImage.toLocaleString('en-US')}<span style="font-size:16px;color:var(--ink-3)">/${totals.roomRecords.toLocaleString('en-US')}</span></div><div class="k">room images</div></div>
  <div class="stat gap"><div class="v">${gapCount}</div><div class="k">properties with a gap</div></div>
  <div class="stat act"><div class="v">${PENDING.size}</div><div class="k">written, read pending</div></div>
</div>

<div class="controls">
  <input type="search" id="q" placeholder="Filter by property code — e.g. RRI207" aria-label="Filter by property code">
  <button id="all" aria-pressed="true">All</button>
  <button id="gaps" aria-pressed="false">Gaps only</button>
  <span class="hint" id="count"></span>
</div>

<div class="tablewrap"><table>
  <thead><tr>
    <th>Property</th><th>Listing</th><th>Ext.</th><th>Int.</th><th>Rooms</th><th>Gallery total</th><th>Room images</th><th>Room types &middot; images each</th>
  </tr></thead>
  <tbody id="tb">
${body}
  </tbody>
</table></div>

<p class="note"><b>Amber marks a zero.</b> A room chip in amber is a room-type record carrying no image; an em dash in a gallery column means that tab has no CMS record at all. The eight codes badged <b>read pending</b> were filled minutes before this scan and still read back empty — <code>GetComponentData</code> lags hours behind writes on these components, so their real state is the write, not this read.</p>

<footer>
  Read from <code>GetComponentData</code> across all ${totals.properties} property codes.
  Raw data: <code>output/consolidated-report.csv</code> (one row per property),
  <code>output/consolidated-rooms.csv</code> (one row per room-type record, ${totals.roomRecords.toLocaleString('en-US')} rows).
</footer>
</div>
<script>
const tb = document.getElementById('tb');
const rows = [...tb.rows];
const q = document.getElementById('q');
const bAll = document.getElementById('all');
const bGaps = document.getElementById('gaps');
const count = document.getElementById('count');
let gapsOnly = false;
function apply() {
  const term = q.value.trim().toLowerCase();
  let shown = 0;
  for (const r of rows) {
    const okTerm = !term || r.dataset.code.includes(term);
    const okGap = !gapsOnly || r.dataset.gap === '1';
    const show = okTerm && okGap;
    r.classList.toggle('hide', !show);
    if (show) shown++;
  }
  count.textContent = shown + ' of ' + rows.length + ' properties';
}
q.addEventListener('input', apply);
bAll.addEventListener('click', () => { gapsOnly = false; bAll.setAttribute('aria-pressed','true'); bGaps.setAttribute('aria-pressed','false'); apply(); });
bGaps.addEventListener('click', () => { gapsOnly = true; bGaps.setAttribute('aria-pressed','true'); bAll.setAttribute('aria-pressed','false'); apply(); });
apply();
</script>`;

await writeFile('output/image-inventory.html', html);
console.log('written', html.length, 'bytes |', ok.length, 'rows |', totals.roomRecords, 'room records | gaps', gapCount);
