import { logAction } from '../actionLog.js';

const CLIENT_APPS = ['PageStudio', 'ProgrammingApp', 'ContentStudio', 'Cms6Backend', 'MPCBackend', 'AzureFunc'];

/**
 * Creates a new MiBlock (component) record via CreateComponentRecord.
 * UNDOCUMENTED endpoint - only an auto-generated Swagger stub is available
 * (no field-by-field spec like UpdateMiblockRecordAsset has). The payload
 * shape here is inferred by cross-referencing an existing room-type record
 * returned by GetComponentData. Treat every write as a real production
 * write - verify the response and the live record before trusting it.
 */
export async function createComponentRecord({ componentAliasName, records }) {
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
    'Content-Type': 'application/json',
    ms_cms_clientapp: clientApp,
    Authorization: `Bearer ${token}`,
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(`${baseUrl}/api/MiblockApi/CreateComponentRecord`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      componentName: componentAliasName,
      recordList: records,
      ProcessAssets: false,
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
    action: 'createComponentRecord',
    componentAliasName,
    records,
    httpStatus: res.status,
    response: body,
  });

  return { status: res.status, body };
}

/**
 * Builds one recordList entry for a new room-type record, mirroring the
 * field shape observed on an existing room-type record's Data payload
 * (minus image fields, which are out of scope for now).
 */
export function buildRoomTypeRecordPayload({
  parentRecordId,
  miBlockId,
  siteId,
  roomTypeCode,
  roomTypeDescription,
  roomImagesAlt,
}) {
  const data = {
    ProfileCouponMapping: '',
    ComponentLevel: '5',
    displayName: 'Room Type',
    Offset: '+00:00',
    ComponentName: 'Room Type',
    RecordText: '',
    PluginName: '',
    PrimaryLanguageRecordId: '0',
    UrlLanguageCode: '',
    LanguageId: '0',
    IsAdditionalMappingAllowed: 'False',
    'room-type-code': roomTypeCode,
    'room-type-description': roomTypeDescription,
    ...(roomImagesAlt ? { 'room-images-alt': roomImagesAlt } : {}),
    EnableClientEdit: true,
    IsRecordIncludedInTranslation: false,
    IsLanguageRecordInEnglish: false,
    IsProtected: 'false',
    IsMemberRoleTaggingEnable: 'false',
    'api-unique-id': roomTypeCode,
  };

  return {
    RecordId: 0,
    Id: 0,
    CmpId: miBlockId,
    ComponentId: miBlockId,
    ParentRecordId: parentRecordId,
    SiteId: siteId,
    ComponentName: 'Room Type',
    ComponentAliasName: 'room-type',
    Status: true,
    IsPlaceholderRecord: false,
    RecordJsonString: JSON.stringify(data),
  };
}
