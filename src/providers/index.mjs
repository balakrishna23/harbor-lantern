import { pdlProvider, buildPdlQuery, pdlLookup } from "./pdl.mjs";

/** Providers the runner can call directly over an API. */
export const apiProviders = {
  pdl: {
    ...pdlProvider,
    buildQuery: buildPdlQuery,
    lookup: (query, options) => pdlLookup(query, { ...options, apiKey: options?.apiKey ?? process.env.PDL_API_KEY })
  }
};

export function getApiProvider(id) {
  const provider = apiProviders[id];
  if (!provider) throw new Error(`Unknown provider "${id}". Available: ${Object.keys(apiProviders).join(", ")}`);
  return provider;
}
