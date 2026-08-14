import { logAction } from '../actionLog.js';

const CLIENT_APPS = ['PageStudio', 'ProgrammingApp', 'ContentStudio', 'Cms6Backend', 'MPCBackend', 'AzureFunc'];

/**
 * Deletes one or more MiBlock records via DeleteComponentRecord.
 * UNDOCUMENTED endpoint - no field-by-field spec available (same situation
 * as CreateComponentRecord). PERMANENT - there is no known undo. Always
 * test on a single known RecordId before ever batching this.
 */
export async function deleteComponentRecord({ miBlockId, recordIds }) {
  const baseUrl = process.env.CMS_WRITE_BASE_URL;
  const token = process.env.CMS_BEARER_TOKEN;
  const clientApp = process.env.CMS_CLIENT_APP || 'ProgrammingApp';
  const cookie = process.env.CMS_SESSION_COOKIE;
  const siteId = Number(process.env.CMS_SITE_ID || 17677);

  if (!baseUrl) throw new Error('CMS_WRITE_BASE_URL is not set');
  if (!token) throw new Error('CMS_BEARER_TOKEN is not set');
  if (!CLIENT_APPS.includes(clientApp)) {
    throw new Error(`CMS_CLIENT_APP must be one of: ${CLIENT_APPS.join(', ')}`);
  }

  const headers = {
    'Content-Type': 'application/json',
    ms_cms_clientapp: clientApp,
    Authorization: `Bearer ${token}`,
  };
  if (cookie) headers.Cookie = cookie;

  const ids = Array.isArray(recordIds) ? recordIds : [recordIds];

  const res = await fetch(`${baseUrl}/api/ComponentApi/DeleteComponentRecord`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ComponentIds: String(miBlockId),
      DeleteIDs: ids.join(','),
      SiteId: siteId,
    }),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (res.status === 401) {
    throw new Error('CMS auth failed: User Session Expired (check CMS_BEARER_TOKEN)');
  }

  await logAction({
    action: 'deleteComponentRecord',
    miBlockId,
    recordIds: ids,
    httpStatus: res.status,
    response: body,
  });

  return { status: res.status, body };
}
