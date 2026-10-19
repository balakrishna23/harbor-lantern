/**
 * Institution -> Australian state inference.
 *
 * The national register extract has no usable location (Suburb/State/Postcode
 * hold the first name), so the state a nurse TRAINED in is the best location
 * hint available. It is a soft signal only: people move after graduating.
 *
 * Matching is whole-word containment, longest key first. It deliberately does
 * NOT do the reverse check (key contains the source string), because the
 * register has short junk institution values such as "Education" that would
 * otherwise match "Think Education" and similar.
 *
 * state: null means the provider is multi-state or online, so no inference.
 */
import { AU_INSTITUTION_DOMAINS } from "./qualification-parser.mjs";

const EXTRA_INSTITUTIONS = {
  // Universities
  "curtin university": "WA",
  "murdoch university": "WA",
  "university of western australia": "WA",
  "central queensland university": "QLD",
  "university of southern queensland": "QLD",
  "university of the sunshine coast": "QLD",
  "james cook university": "QLD",
  "bond university": "QLD",
  "southern cross university": "NSW",
  "victoria university": "VIC",
  "federation university": "VIC",
  "university of ballarat": "VIC",
  "rmit university": "VIC",
  "swinburne university": "VIC",
  "university of adelaide": "SA",
  "avondale": "NSW",
  "university of notre dame": null,
  "torrens university": null,
  // TAFEs and public RTOs
  "tafe queensland": "QLD",
  "tafe sa": "SA",
  "tastafe": "TAS",
  "north metropolitan tafe": "WA",
  "south metropolitan tafe": "WA",
  "central regional tafe": "WA",
  "south regional tafe": "WA",
  "central institute of technology": "WA",
  "west coast institute of training": "WA",
  "challenger institute of technology": "WA",
  "western australian school of nursing": "WA",
  "chisholm institute": "VIC",
  "wodonga institute of tafe": "VIC",
  "goulburn ovens institute of tafe": "VIC",
  "gotafe": "VIC",
  "box hill institute": "VIC",
  "gordon institute of tafe": "VIC",
  "south west institute of tafe": "VIC",
  "bendigo kangan institute": "VIC",
  "kangan institute": "VIC",
  "bendigo tafe": "VIC",
  "tafe gippsland": "VIC",
  "federation training": "VIC",
  "holmesglen": "VIC",
  "hunter institute": "NSW",
  "uow college": "NSW",
  // Hospital-based and college training (historic)
  "mater education": "QLD",
  "royal north shore hospital": "NSW",
  "royal prince alfred hospital": "NSW",
  "st vincent s hospital sydney": "NSW",
  "new south wales college of nursing": "NSW",
  "westmead": "NSW",
  "sydney college of advanced education": "NSW",
  "catholic college of education": "NSW",
  "concord repatriation": "NSW",
  "st george hospital": "NSW",
  "royal alexandra hospital for children": "NSW",
  "blacktown hospital": "NSW",
  "royal newcastle hospital": "NSW",
  "hornsby ku ring gai hospital": "NSW",
  "gosford district hospital": "NSW",
  "kuring gai college of advanced education": "NSW",
  // Multi-state, online or uncertain: explicitly no inference
  "think education": null,
  "careers australia": null,
  "open colleges": null,
  "equals international": null,
  "health skills australia": null,
  "skills training australia": null,
  "care training australia": null,
  "partners in training australia": null,
  "southern cross education institute": null,
  "australian nursing and midwifery education centre": null,
  "menzies institute of technology": null,
  "queensford college": null,
  "acknowledge education": null,
  "mayfield education": null,
  "vfa learning": null,
  "acu college": null,
  "lonsdale institute": null,
  "mater misericordiae": null,
  // Overrides of the shared domain table: these deliver across several states
  "australian catholic university": null,
  "australian college of nursing": null,
  "institute of health and nursing australia": null,
  "ihna": null,
  "institute of health and management": null
};

const norm = (value) => ` ${String(value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;

const ENTRIES = (() => {
  const merged = new Map();
  for (const [key, val] of Object.entries(AU_INSTITUTION_DOMAINS)) {
    if (key.length >= 4) merged.set(key, { state: val.state ?? null, name: val.name });
  }
  for (const [key, state] of Object.entries(EXTRA_INSTITUTIONS)) merged.set(key, { state, name: null });
  return [...merged.entries()]
    .map(([key, val]) => ({ key, needle: norm(key), ...val }))
    .sort((a, b) => b.key.length - a.key.length);
})();

/**
 * Returns { state, key, known } for an institution string.
 * known=false means no entry matched; state=null with known=true means the
 * institution is recognised but deliberately not tied to one state.
 */
export function inferInstitutionState(institution) {
  const hay = norm(institution);
  if (hay.trim().length < 4) return { state: null, key: null, known: false };
  for (const entry of ENTRIES) {
    if (hay.includes(entry.needle)) return { state: entry.state, key: entry.key, known: true };
  }
  return { state: null, key: null, known: false };
}

export const institutionStateEntryCount = ENTRIES.length;
