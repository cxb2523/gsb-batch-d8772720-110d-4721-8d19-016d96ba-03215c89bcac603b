"use client";

import { TriangleDownIcon, TriangleUpIcon } from "@primer/octicons-react";
import styles from "./app.module.css";

export type SortDir = "asc" | "desc";

/**
 * Shared sortable table header. Renders the column label with a directional
 * arrow when active, so every table presents the same sort affordance.
 */
export function SortableTh<K extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  numeric = false,
}: {
  label: string;
  sortKey: K;
  activeKey: K;
  dir: SortDir;
  onSort: (key: K) => void;
  numeric?: boolean;
}) {
  const active = activeKey === sortKey;
  return (
    <th className={numeric ? styles.numCol : undefined} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`${styles.sortBtn} ${active ? styles.sortActive : ""}`}
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label}`}
      >
        <span>{label}</span>
        <span className={styles.sortArrow} aria-hidden>
          {active ? (
            dir === "asc" ? (
              <TriangleUpIcon size={14} />
            ) : (
              <TriangleDownIcon size={14} />
            )
          ) : null}
        </span>
      </button>
    </th>
  );
}
