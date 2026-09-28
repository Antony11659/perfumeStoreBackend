
const shops = {
    raspiv: {
      clientId: process.env.OZON_CLIENT_ID_RASPIV,
      apiKey: process.env.OZON_API_KEY_RASPIV,
    },
  
    motive: {
      clientId: process.env.OZON_CLIENT_ID_MOTIVE,
      apiKey: process.env.OZON_API_KEY_MOTIVE,
    },
  
    laDePurfum: {
      clientId: process.env.OZON_CLIENT_ID_LA_DE_PURFUM,
      apiKey: process.env.OZON_API_KEY_LA_DE_PURFUM,
    },
  
    dubaiOil: {
      clientId: process.env.OZON_CLIENT_ID_DUBAI_OIL,
      apiKey: process.env.OZON_API_KEY_DUBAI_OIL,
    },
  };
  
  export const createOzonClient = (shopName) => {
    const shop = shops[shopName];
  
    if (!shop) {
      throw new Error(`Unknown Ozon shop: ${shopName}`);
    }
  
    if (!shop.clientId || !shop.apiKey) {
      throw new Error(`Missing Ozon credentials for shop: ${shopName}`);
    }
  
    return {
      post: async (path, body) => {
        const response = await fetch(
          `https://api-seller.ozon.ru${path}`,
          {
            method: "POST",
  
            headers: {
              "Client-Id": shop.clientId,
              "Api-Key": shop.apiKey,
              "Content-Type": "application/json",
            },
  
            body: JSON.stringify(body),
          }
        );
  
        if (!response.ok) {
          const errorBody = await response.text();
  
          throw new Error(
            `Ozon API error ${response.status}: ${errorBody}`
          );
        }
  
        return response.json();
      },
    };
  };