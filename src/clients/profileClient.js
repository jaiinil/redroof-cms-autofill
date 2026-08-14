const CLIENT_APPS = ['PageStudio', 'ProgrammingApp', 'ContentStudio', 'Cms6Backend', 'MPCBackend', 'AzureFunc'];

let cachedProfiles = null;

/**
 * Fetches (and caches, per process) every property's Profile record, which
 * maps PropertyCode -> ProfileId. This ProfileId must be set on a room-type
 * record for it to actually be visible/functional in the CMS admin's room
 * listing (confirmed via screenshot: admin's manual "Add Component Record"
 * form has a required-in-practice "Select Profile" field, e.g. "Red Roof
 * Inn Akron - 29392" for RRI207) - our automation never set this before
 * this fix, so every room-type record created earlier in this project may
 * not have actually been showing up correctly.
 */
export async function loadAllProfiles() {
  if (cachedProfiles) return cachedProfiles;

  const baseUrl = process.env.CMS_WRITE_BASE_URL;
  const token = process.env.CMS_BEARER_TOKEN;
  const clientApp = process.env.CMS_CLIENT_APP || 'ProgrammingApp';
  const cookie = process.env.CMS_SESSION_COOKIE;

  if (!baseUrl) throw new Error('CMS_WRITE_BASE_URL is not set');
  if (!token) throw new Error('CMS_BEARER_TOKEN is not set');
  if (!CLIENT_APPS.includes(clientApp)) {
    throw new Error(`CMS_CLIENT_APP must be one of: ${CLIENT_APPS.join(', ')}`);
  }

  const headers = {
    Accept: 'application/json',
    ms_cms_clientapp: clientApp,
    Authorization: `Bearer ${token}`,
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(`${baseUrl}/api/ProfileAPI/Get`, { method: 'GET', headers });
  if (res.status === 401) throw new Error('CMS auth failed: User Session Expired (check CMS_BEARER_TOKEN)');

  const json = await res.json();
  cachedProfiles = json.ProfileUnap || [];
  return cachedProfiles;
}

export async function getProfileIdForPropertyCode(propertyCode) {
  const profiles = await loadAllProfiles();
  const match = profiles.find((p) => (p.PropertyCode || '').toUpperCase() === propertyCode.toUpperCase());
  return match ? match.ProfileId : null;
}
