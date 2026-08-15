const BUSINESS_ID = Number(process.env.DAM_BUSINESS_ID || 7976);

export async function searchAssets(body) {
  const baseUrl = process.env.DAM_BASE_URL;
  const token = process.env.DAM_BEARER_TOKEN;
  if (!baseUrl) throw new Error('DAM_BASE_URL is not set');
  if (!token) throw new Error('DAM_BEARER_TOKEN is not set');

  const res = await fetch(`${baseUrl}/api/v2.0/dam/searchassets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ BusinessIds: [BUSINESS_ID], PageSize: 24, ...body }),
  });

  if (res.status === 401) throw new Error('DAM auth failed (check DAM_BEARER_TOKEN)');

  return res.json();
}

/**
 * Lists all DAM assets in a property's siteimages folder.
 * Text-searching the property code itself (e.g. "RRI207") does not hit the
 * folder path metadata - but the numeric part of the code (e.g. "207", which
 * every filename in that folder is prefixed with) does. Results are still
 * filtered to the exact /<propertycode-lower>/ path segment as a safety net
 * against a numeric collision with a different brand prefix (e.g. HTS207).
 */
// Per-process cache: a property's DAM folder contents don't change during a
// run, and findPropertyImageAsset() is called once per image - a gallery with
// 11 images would otherwise re-fetch (and re-page) the same folder 11 times.
const propertyImagesCache = new Map();

export async function listPropertyImages(propertyCode) {
  const cacheKey = propertyCode.toLowerCase();
  if (propertyImagesCache.has(cacheKey)) return propertyImagesCache.get(cacheKey);

  const numericPart = propertyCode.match(/\d+/)?.[0];
  if (!numericPart) return [];

  const pathFragment = `/${propertyCode.toLowerCase()}/`;
  const pageSize = 100;
  let page = 1;
  const all = [];

  while (true) {
    const result = await searchAssets({ TextToSearch: numericPart, SearchByAll: true, PageNumber: page, PageSize: pageSize });
    const assets = result.assetInfos || result.AssetInfos || [];
    all.push(...assets.filter((a) => a.path?.toLowerCase().includes(pathFragment)));
    if (assets.length < pageSize) break;
    page += 1;
  }

  propertyImagesCache.set(cacheKey, all);
  return all;
}

function normalize(fileName) {
  return fileName
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSetSimilarity(a, b) {
  const setA = new Set(normalize(a).split(' ').filter(Boolean));
  const setB = new Set(normalize(b).split(' ').filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union; // Jaccard similarity, 0..1
}

const FUZZY_THRESHOLD = 0.6;

/**
 * Reduces a filename to a "family key" that groups variants of the same
 * photo together - e.g. "207-superior king.jpg", "207-superior king 2.jpg"
 * and "207-superior king 3.jpg" all reduce to "207 superior king". Works by
 * separating letter/digit boundaries (so "king2" behaves like "king 2"),
 * then dropping a single trailing numeric token (the variant index) if
 * present. A trailing number embedded earlier in the name (e.g. "2 full
 * beds") is not a variant index and is left alone.
 */
function familyKey(fileName) {
  const withSeparatedDigits = fileName
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2');
  const tokens = withSeparatedDigits.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

/**
 * Finds every DAM asset belonging to the same photo family as a reference
 * filename, within a property's folder (e.g. all "superior king" variants,
 * not just the one the reference API happened to link as the thumbnail).
 * Tries an exact family match first; falls back to fuzzy family-key
 * similarity for names that drifted. Returns
 * { assets: [...], matchType: 'exact'|'fuzzy', score } or null if nothing
 * clears the confidence threshold.
 */
export async function findPropertyImageGroup(propertyCode, fileName) {
  if (!fileName) return null;
  const images = await listPropertyImages(propertyCode);
  if (!images.length) return null;

  const targetKey = familyKey(fileName);
  const exactGroup = images.filter((a) => familyKey(a.alias || a.name || '') === targetKey);
  if (exactGroup.length) return { assets: exactGroup, matchType: 'exact', score: 1, familyKey: targetKey };

  const familyKeys = new Map(); // familyKey -> assets[]
  for (const img of images) {
    const key = familyKey(img.alias || img.name || '');
    if (!familyKeys.has(key)) familyKeys.set(key, []);
    familyKeys.get(key).push(img);
  }

  let bestKey = null;
  let bestScore = 0;
  for (const key of familyKeys.keys()) {
    const score = tokenSetSimilarity(targetKey, key);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  if (bestKey && bestScore >= FUZZY_THRESHOLD) {
    return { assets: familyKeys.get(bestKey), matchType: 'fuzzy', score: bestScore, familyKey: bestKey };
  }

  return null;
}

/**
 * Finds the DAM asset for a reference-API image filename within a property's
 * folder. Tries an exact alias match first; falls back to fuzzy token-overlap
 * matching (for filenames that drifted slightly - extra/missing words,
 * different separators) among that property's own images only. Returns
 * { asset, matchType: 'exact'|'fuzzy', score } or null if nothing clears the
 * confidence threshold - callers must not guess further than this.
 */
export async function findPropertyImageAsset(propertyCode, fileName) {
  if (!fileName) return null;
  const images = await listPropertyImages(propertyCode);
  if (!images.length) return null;

  const exact = images.find((a) => a.alias?.toLowerCase() === fileName.toLowerCase());
  if (exact) return { asset: exact, matchType: 'exact', score: 1 };

  let best = null;
  let bestScore = 0;
  for (const img of images) {
    const score = tokenSetSimilarity(fileName, img.alias || img.name || '');
    if (score > bestScore) {
      bestScore = score;
      best = img;
    }
  }

  if (best && bestScore >= FUZZY_THRESHOLD) {
    return { asset: best, matchType: 'fuzzy', score: bestScore };
  }

  return null;
}
