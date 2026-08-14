const REDISTAY_ENDPOINT = 'https://api-gateway.redistay.com/web/prd/api/property/GetWebContent';

/**
 * Fetches reference web content data from RediStay. Used only as a reference
 * source to compare against our CMS component data — not written back to.
 * @param {string[]} propertyIds e.g. ["RRI656"]
 * @param {string} [device] e.g. "Web" | "Mobile"
 */
export async function getWebContent(propertyIds, device = 'Web') {
  const subscriptionKey = process.env.REDISTAY_SUBSCRIPTION_KEY;
  if (!subscriptionKey) {
    throw new Error('REDISTAY_SUBSCRIPTION_KEY is not set (see .env.example)');
  }

  const body = {
    Device: device,
    PropertyIds: propertyIds,
  };

  const res = await fetch(REDISTAY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': subscriptionKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`RediStay API error ${res.status}: ${await res.text()}`);
  }

  return res.json();
}
