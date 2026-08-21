/**
 * currency.js — Currency resolution and formatting helper.
 *
 * Resolves the business's active currency from the Settings table
 * and provides a locale-aware formatter. Used by every nav route
 * instead of hardcoding "en-KE" and "KES".
 *
 * Currency map covers common East African and global currencies.
 */

const CURRENCY_MAP = {
  KES: { locale: "en-KE", symbol: "Ksh", name: "Kenya Shilling" },
  UGX: { locale: "en-UG", symbol: "Ush", name: "Uganda Shilling" },
  TZS: { locale: "en-TZ", symbol: "Tsh", name: "Tanzania Shilling" },
  RWF: { locale: "rw-RW", symbol: "FRf", name: "Rwanda Franc" },
  ETB: { locale: "am-ET", symbol: "Br", name: "Ethiopian Birr" },
  NGN: { locale: "en-NG", symbol: "₦", name: "Nigerian Naira" },
  GHS: { locale: "en-GH", symbol: "GH₵", name: "Ghana Cedi" },
  ZAR: { locale: "en-ZA", symbol: "R", name: "South African Rand" },
  USD: { locale: "en-US", symbol: "$", name: "US Dollar" },
  GBP: { locale: "en-GB", symbol: "£", name: "British Pound" },
  EUR: { locale: "de-DE", symbol: "€", name: "Euro" },
  INR: { locale: "en-IN", symbol: "₹", name: "Indian Rupee" },
};

const DEFAULT_CURRENCY = "KES";

/**
 * getCurrencyConfig — reads DEFAULT_CURRENCY from Settings, falls back
 * to Organisation.Organisation_Currency, then to "KES".
 */
async function getCurrencyConfig(prisma, entrepriseId) {
  let code = DEFAULT_CURRENCY;

  try {
    const setting = await prisma.Settings.findFirst({
      where: { Setting_Name: "DEFAULT_CURRENCY", Entreprise_id: entrepriseId },
    });
    if (setting && setting.Setting_Value) code = setting.Setting_Value.toUpperCase();
  } catch {
    // Settings table may not exist yet
  }

  if (!CURRENCY_MAP[code]) {
    // Try Organisation table
    try {
      const org = await prisma.Organisation.findUnique({ where: { Entreprise_id: entrepriseId } });
      if (org && org.Organisation_Currency) code = org.Organisation_Currency.toUpperCase();
    } catch { /* ignore */ }
  }

  const config = CURRENCY_MAP[code] || CURRENCY_MAP[DEFAULT_CURRENCY];
  return { code, ...config };
}

/**
 * makeFmt — creates a locale-aware currency formatter function.
 * Returns a function that formats numbers with the business's currency locale.
 */
function makeFmt(currencyConfig) {
  const locale = currencyConfig.locale || "en-KE";
  return (n) => Number(n || 0).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

module.exports = { getCurrencyConfig, makeFmt, CURRENCY_MAP, DEFAULT_CURRENCY };
