// Read once at startup. Changing configuration requires a process restart.
export const websiteOzonPayEnabled = process.env.WEBSITE_OZON_PAY_ENABLED === "true";
