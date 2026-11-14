import type { ComponentType } from 'react'

/**
 * What differs in the static web demo (GitHub Pages). In this build — the real app that
 * `mecha serve` ships — there is no demo code at all: the web demo build swaps this module
 * for `src/demo/edition.tsx` (vite.pages.config.ts), and scripts/check_web_builds.py checks
 * that no demo data ends up here.
 */
export interface SamplePickerProps {
  /** `value` is what the in-memory API accepts as a sample (opaque to the real app). */
  onPick: (value: string, label: string) => void
  pending: boolean
}

/** True only in the web demo: fields that need the Python state engine are disabled. */
export const STATIC_DEMO: boolean = false

/** "Add" in the web demo: sample keys to pick, never a field to paste one. */
export const SamplePicker: ComponentType<SamplePickerProps> | null = null

/** The fixed notice at the top of the web demo. */
export const StaticBanner: ComponentType | null = null
