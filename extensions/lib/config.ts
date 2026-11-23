import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Persistent preferences come from Pi's effective settings. */
export interface CapBudget { unit: "chars" | "tokens" | "percent"; value: number }
export type CapMode = "on" | "off" | "warn";
export type CompactionMethod = "verbatim" | "summary";
export interface Preferences {
  compactionMethod: CompactionMethod;
  capMode: CapMode;
  capBudget: CapBudget;
  lookupModel: string;
  lookupTurns: number;
  lookupMaxCalls: number;
  mainAgentLookup: boolean;
}
export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
  compactionMethod: "verbatim",
  capMode: "warn",
  capBudget: { unit: "percent", value: 25 },
  lookupModel: "",
  lookupTurns: 25,
  lookupMaxCalls: 3,
  mainAgentLookup: false,
};
export type PreferenceKey = keyof Preferences;
export type PreferencePatch = { [K in PreferenceKey]?: Preferences[K] | null };
export const SETTINGS_ENTRY = "transparent-compact:settings";
export const METHOD_ENTRY = "transparent-compact:compaction-method";
export const CAP_ENTRY = "transparent-compact:cap-compaction";
export const MAIN_MODE_ENTRY = "transparent-compact:main-agent-lookup";
// DEPRECATED: legacy autoFilter settings and transparent-compact:auto-filter
// session entries are intentionally ignored. TODO(1.x.x): remove this note and
// the associated autoFilter compatibility fixtures; do not restore the option.
export const PREFERENCE_KEYS: PreferenceKey[] = ["compactionMethod", "capMode", "capBudget",
  "lookupModel", "lookupTurns", "lookupMaxCalls", "mainAgentLookup"];

export function validCapBudget(value: unknown): value is CapBudget {
  if (!value || typeof value !== "object") return false;
  const { unit, value: n } = value as CapBudget;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return false;
  if (unit === "percent") return n <= 100;
  return Number.isSafeInteger(n) && (unit === "chars" || (unit === "tokens" && n <= Number.MAX_SAFE_INTEGER / 4));
}
export function parseCapBudget(text: string): CapBudget | undefined {
  const match = /^(\d+(?:\.\d+)?)(c|t|%)$/.exec(text.trim());
  if (!match) return;
  const budget: CapBudget = { value: Number(match[1]), unit: match[2] === "c" ? "chars" : match[2] === "t" ? "tokens" : "percent" };
  return validCapBudget(budget) ? budget : undefined;
}
export function capBudgetText(budget: CapBudget): string {
  return `${budget.value}${budget.unit === "chars" ? "c" : budget.unit === "tokens" ? "t" : "%"}`;
}
export function validPreference(key: PreferenceKey, value: unknown): boolean {
  switch (key) {
    case "compactionMethod": return value === "verbatim" || value === "summary";
    case "capMode": return value === "on" || value === "off" || value === "warn";
    case "capBudget": return validCapBudget(value);
    case "mainAgentLookup": return typeof value === "boolean";
    case "lookupModel": return typeof value === "string" && (!value.trim() || /^[^/\s]+\/\S+$/.test(value.trim()));
    case "lookupTurns": return integer(value, 1) !== undefined;
    case "lookupMaxCalls": return integer(value, 0) !== undefined;
  }
}
export function recoveryLocked(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) => entry.type === "compaction" || (entry.type === "custom" && entry.customType === MAIN_MODE_ENTRY));
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown, minimum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : undefined;
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100 ? value : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function resolveConfig(settings: unknown, env: Record<string, string | undefined> = process.env) {
  const config = object(object(settings).transparentCompact);
  const envNumber = (name: string) => {
    const raw = nonempty(env[name]);
    return raw === undefined ? undefined : Number(raw);
  };
  // Invalid or empty overrides are ignored, just like invalid file values.
  const chars = integer(envNumber("MECH_COMPACT_MAX_SUMMARY_CHARS"), 1) ?? integer(config.maxSummaryChars, 1);
  const percentage = percent(envNumber("MECH_COMPACT_MAX_SUMMARY_PERCENT")) ?? percent(config.maxSummaryPercent) ?? DEFAULT_PREFERENCES.capBudget.value;
  const direct = nonempty(env.MECH_COMPACT_MAIN_AGENT_LOOKUP);
  return {
    // Resolve each key's precedence first; a fixed character cap wins over a percentage.
    defaultCapBudget: (chars === undefined ? { unit: "percent", value: percentage } : { unit: "chars", value: chars }) as CapBudget,
    lookupTurns: integer(envNumber("MECH_COMPACT_LOOKUP_TURNS"), 1) ?? integer(config.lookupTurns, 1) ?? DEFAULT_PREFERENCES.lookupTurns,
    lookupMaxCalls: integer(envNumber("MECH_COMPACT_LOOKUP_MAX_CALLS"), 0) ?? integer(config.lookupMaxCalls, 0) ?? DEFAULT_PREFERENCES.lookupMaxCalls,
    lookupModel: nonempty(env.MECH_COMPACT_LOOKUP_MODEL) ?? nonempty(config.lookupModel),
    mainAgentLookup: direct === "1" ? true : direct === "0" ? false
      : typeof config.mainAgentLookup === "boolean" ? config.mainAgentLookup : DEFAULT_PREFERENCES.mainAgentLookup,
  };
}

/** Branch-local overrides; null removes an override rather than freezing today's default. */
export function preferenceState(settings: unknown, entries: readonly SessionEntry[], env: Record<string, string | undefined> = process.env) {
  const cfg = resolveConfig(settings, env), file = object(object(settings).transparentCompact);
  const defaults: Preferences = {
    compactionMethod: validPreference("compactionMethod", file.compactionMethod) ? file.compactionMethod as CompactionMethod : DEFAULT_PREFERENCES.compactionMethod,
    capMode: validPreference("capMode", file.capMode) ? file.capMode as CapMode : DEFAULT_PREFERENCES.capMode,
    capBudget: cfg.defaultCapBudget,
    lookupModel: cfg.lookupModel ?? DEFAULT_PREFERENCES.lookupModel, lookupTurns: cfg.lookupTurns, lookupMaxCalls: cfg.lookupMaxCalls,
    mainAgentLookup: cfg.mainAgentLookup,
  };
  const overrides: Partial<Preferences> = {};
  const apply = (patch: Record<string, unknown>) => {
    for (const key of PREFERENCE_KEYS) {
      if (patch[key] === null) delete overrides[key];
      else if (validPreference(key, patch[key])) Object.assign(overrides, { [key]: patch[key] });
    }
  };
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const data = object(entry.data);
    if (entry.customType === SETTINGS_ENTRY) apply(data);
    // These are also written by the cap-confirmation flow and existing session controls.
    else if (entry.customType === CAP_ENTRY) apply({ capMode: data.mode, capBudget: data.budget });
    else if (entry.customType === METHOD_ENTRY) apply({ compactionMethod: data.method });
  }
  const values = { ...defaults, ...overrides };
  return { values, defaults, overrides };
}

export function sessionPreferences(settings: unknown, entries: readonly SessionEntry[]): Preferences {
  return preferenceState(settings, entries).values;
}
