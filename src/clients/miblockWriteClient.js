import { logAction } from '../actionLog.js';

const CLIENT_APPS = ['PageStudio', 'ProgrammingApp', 'ContentStudio', 'Cms6Backend', 'MPCBackend', 'AzureFunc'];

let sessionCookie = null;

/**
 * Attaches DAM asset URLs to file/image fields of an existing MiBlock record.
 * PRODUCTION write endpoint — replaces (not appends to) the target field(s).
 * @param {{ miBlockId: number, recordId: number, assetFields: { fieldAlias: string, assetUrls: string[] }[] }} params
 */
export async function updateMiblockRecordAsset({ miBlockId, recordId, assetFields }) {
  const baseUrl = process.env.CMS_WRITE_BASE_URL || process.env.CMS_BASE_URL;
  const token = process.env.CMS_BEARER_TOKEN;
  const clientApp = process.env.CMS_CLIENT_APP || 'ProgrammingApp';

  if (!baseUrl) throw new Error('CMS_WRITE_BASE_URL (or CMS_BASE_URL) is not set');
  if (!token) throw new Error('CMS_BEARER_TOKEN is not set');
  if (!CLIENT_APPS.includes(clientApp)) {
    throw new Error(`CMS_CLIENT_APP must be one of: ${CLIENT_APPS.join(', ')}`);
  }

  const headers = {
    'Content-Type': 'application/json',
    ms_cms_clientapp: clientApp,
    Authorization: `Bearer ${token}`,
  };
  const cookie = sessionCookie || process.env.CMS_SESSION_COOKIE;
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(`${baseUrl}/api/MiblockApi/UpdateMiblockRecordAsset`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      MiBlockId: miBlockId,
      RecordId: recordId,
      AssetFields: assetFields.map((f) => ({ FieldAlias: f.fieldAlias, AssetUrls: f.assetUrls })),
    }),
  });

  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (setCookie.length) {
    sessionCookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  }

  if (res.status === 401) {
    throw new Error('CMS auth failed: User Session Expired (check CMS_BEARER_TOKEN)');
  }

  const body = await res.json();

  await logAction({
    action: 'updateMiblockRecordAsset',
    miBlockId,
    recordId,
    assetFields,
    httpStatus: res.status,
    response: body,
  });

  if (!body.Success) {
    throw new Error(`Whole request rejected: ${body.ErrorMessage}`);
  }

  const sentAliases = assetFields.map((f) => f.fieldAlias.toLowerCase());
  const returnedAliases = (body.UpdateMiBlockRecordStatuses || []).map((s) => s.FieldAlias.toLowerCase());
  const missingAliases = sentAliases.filter((a) => !returnedAliases.includes(a));

  return {
    raw: body,
    fieldStatuses: body.UpdateMiBlockRecordStatuses || [],
    missingAliases, // sent but no status returned -> did not get applied, must retry/escalate
  };
}
