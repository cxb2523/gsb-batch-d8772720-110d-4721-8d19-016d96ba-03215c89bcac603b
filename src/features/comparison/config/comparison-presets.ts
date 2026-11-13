export const COMPARISON_PRESETS = [
  {
    username1: "yyx990803",
    username2: "antfu",
    labelKey: "presets.evanVsAnthony",
  },
  {
    username1: "rauchg",
    username2: "leerob",
    labelKey: "presets.guillermoVsLee",
  },
  {
    username1: "kentcdodds",
    username2: "t3dotgg",
    labelKey: "presets.kentVsTheo",
  },
] as const;

export type ComparisonPreset = (typeof COMPARISON_PRESETS)[number];
