"use client";

import { Flash, Text } from "@primer/react";
import { AlertIcon, InfoIcon } from "@primer/octicons-react";
import {
  preloadOutcomeMessage,
  type PreloadOutcome,
  type PreloadSlot,
} from "@/lib/preload";
import styles from "./app.module.css";

/**
 * Plain-language explanation of how a preloaded-report probe ended. Renders
 * nothing while the slot is unprobed or after a successful load, so success
 * states stay free of failure messaging. The text contains only the fixed
 * outcome wording - never CSV contents, file names, or per-user data.
 */
export function PreloadOutcomeNotice({
  slot,
  outcome,
}: {
  slot: PreloadSlot;
  outcome: PreloadOutcome | null;
}) {
  if (!outcome || outcome === "success") return null;

  // A missing optional file is an expected, neutral state; anything else means
  // the probe reached something unusable and deserves a warning treatment.
  const neutral = outcome === "not_found";

  return (
    <Flash variant={neutral ? "default" : "warning"} className={styles.preloadNotice}>
      {neutral ? <InfoIcon size={16} /> : <AlertIcon size={16} />}
      <Text as="p" className={styles.preloadNoticeText}>
        {preloadOutcomeMessage(slot, outcome)}
      </Text>
    </Flash>
  );
}
