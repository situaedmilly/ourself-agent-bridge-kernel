const SCHEMA = "TRUST_CONFIGURATION_OURSELFECOSYSTEM/v1";
const required = ["seat.public_key_pem", "seat.issuer", "seat.audience", "portal.public_key_pem", "portal.issuer", "portal.audience"];
const nonblank = value => typeof value === "string" && value.trim().length > 0;
const validPublicKey = value => nonblank(value) && value.includes("-----BEGIN PUBLIC KEY-----") && value.includes("-----END PUBLIC KEY-----");

export function resolveTrustConfiguration(env = {}) {
  let config;
  let source = "TRUST_CONFIGURATION_OURSELFECOSYSTEM";
  if (nonblank(env.TRUST_CONFIGURATION_OURSELFECOSYSTEM)) {
    try { config = JSON.parse(env.TRUST_CONFIGURATION_OURSELFECOSYSTEM); }
    catch { return { state: "INVALID", source, missing: [], invalid: ["TRUST_CONFIGURATION_OURSELFECOSYSTEM_JSON"], config: null }; }
    if (config?.schema !== SCHEMA) return { state: "INVALID", source, missing: [], invalid: ["schema"], config: null };
  } else {
    source = "LEGACY_WRANGLER_BINDINGS";
    config = {
      schema: SCHEMA,
      seat: { public_key_pem: env.OSOS_SEAT_PUBLIC_KEY_PEM, issuer: env.OURHOSTSELF_SEAT_ISSUER, audience: env.OURHOSTSELF_SEAT_AUDIENCE || "ourtunnelself" },
      portal: { public_key_pem: env.OSOS_PORTAL_PUBLIC_KEY_PEM, issuer: env.OURHOSTSELF_PORTAL_ISSUER, audience: env.OURHOSTSELF_PORTAL_AUDIENCE || "ourtunnelself" }
    };
  }
  const missing = required.filter(path => {
    const [section, key] = path.split(".");
    return !nonblank(config?.[section]?.[key]);
  });
  const invalid = [];
  if (nonblank(config?.seat?.public_key_pem) && !validPublicKey(config.seat.public_key_pem)) invalid.push("seat.public_key_pem");
  if (nonblank(config?.portal?.public_key_pem) && !validPublicKey(config.portal.public_key_pem)) invalid.push("portal.public_key_pem");
  for (const [section, key, max] of [["seat","issuer",512],["portal","issuer",512],["seat","audience",256],["portal","audience",256]]) {
    if (nonblank(config?.[section]?.[key]) && config[section][key].length > max) invalid.push(section + "." + key);
  }
  return { state: missing.length || invalid.length ? "INVALID" : "READY", source, missing, invalid, config: missing.length || invalid.length ? null : config };
}
export const TRUST_CONFIGURATION_SCHEMA = SCHEMA;
