const CMS_ENDPOINT = 'https://redroof.cms.milestoneinternet.info/api/ComponentApi/GetComponentData';

/**
 * Fetches raw component data from the Milestone CMS (our primary CMS).
 * @param {string} propertyCode e.g. "RRI207"
 * @param {string} componentAliasName e.g. "property-data"
 */
export async function getComponentData(propertyCode, componentAliasName = 'property-data') {
  const body = {
    ComponentAliasName: componentAliasName,
    IsCaching: false,
    IsJsonResult: true,
    ShowRecordsForNonProfilePage: true,
    ApplyFilterToParentOnly: true,
    ComponentFilters: [
      {
        FieldName: 'property-code',
        FieldValue: [propertyCode],
      },
    ],
  };

  const res = await fetch(CMS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`CMS API error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}
