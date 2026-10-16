const DADATA_SUGGEST_ADDRESS_URL =
  "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address";


/**
 * Search Russian addresses using DaData suggestions.
 *
 * Example:
 *
 * suggestAddress("Москва Кутузовский 22")
 *
 * Returns only the fields our website actually needs.
 */
export async function suggestAddress(
  query,
  {
    count = 5,
  } = {}
) {
  const apiKey =
    process.env.DADATA_API_KEY;

  if (!apiKey) {
    throw new Error(
      "DADATA_API_KEY is missing"
    );
  }

  const normalizedQuery =
    String(query || "").trim();

  if (!normalizedQuery) {
    return [];
  }

  const response = await fetch(
    DADATA_SUGGEST_ADDRESS_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Token ${apiKey}`,
      },

      body: JSON.stringify({
        query: normalizedQuery,
        count,
      }),
    }
  );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `DaData address suggestions failed (${response.status}): ${body}`
    );
  }

  const data =
    await response.json();

  const suggestions =
    Array.isArray(data.suggestions)
      ? data.suggestions
      : [];

  return suggestions.map((item) => {
    const addressData =
      item.data || {};

    return {
      address:
        item.value || null,

      city:
        addressData.city ||
        addressData.settlement ||
        null,

      street:
        addressData.street ||
        null,

      house:
        addressData.house ||
        null,

      latitude:
        addressData.geo_lat
          ? Number(addressData.geo_lat)
          : null,

      longitude:
        addressData.geo_lon
          ? Number(addressData.geo_lon)
          : null,
    };
  });
}