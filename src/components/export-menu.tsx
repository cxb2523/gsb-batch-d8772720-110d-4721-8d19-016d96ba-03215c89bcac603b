"use client";

import { useState, type RefObject } from "react";
import { ActionList, ActionMenu, IconButton } from "@primer/react";
import { DownloadIcon, FileMediaIcon, FileIcon } from "@primer/octicons-react";
import { toast } from "sonner";
import { exportChartPng, exportSummaryPdf, type ExportStat } from "@/lib/export";

interface ExportMenuProps {
  /**
   * Ref to the element containing the chart's <svg>. Omit for table-only tools;
   * the PDF will then contain just the key stats and the PNG option is hidden.
   */
  chartRef?: RefObject<HTMLElement | null>;
  /** Whether to offer the PNG (chart image) export. Defaults to true. */
  canExportPng?: boolean;
  /** Human title used for filenames and the PDF heading. */
  title: string;
  /** Key figures rendered into the PDF summary. */
  stats?: ExportStat[];
  /** Optional one-line description shown under the PDF title. */
  subtitle?: string;
}

/**
 * Reusable export control shared by every tool. Offers PNG (chart image) and
 * PDF (chart + key stats) downloads, generated entirely client-side.
 */
export function ExportMenu({
  chartRef,
  canExportPng = true,
  title,
  stats = [],
  subtitle,
}: ExportMenuProps) {
  const [busy, setBusy] = useState(false);

  async function run(kind: "png" | "pdf") {
    setBusy(true);
    try {
      if (kind === "png") {
        const el = chartRef?.current;
        if (!el) {
          toast.error("Nothing to export yet.");
          return;
        }
        await exportChartPng(el, title);
        toast.success("Chart image downloaded.");
      } else {
        await exportSummaryPdf(chartRef?.current ?? null, title, stats, subtitle);
        toast.success("PDF summary downloaded.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <IconButton
          icon={DownloadIcon}
          aria-label="Export this view"
          variant="invisible"
          size="small"
          loading={busy}
        />
      </ActionMenu.Anchor>
      <ActionMenu.Overlay align="end" width="medium">
        <ActionList>
          {canExportPng && (
            <ActionList.Item onSelect={() => run("png")} disabled={busy}>
              <ActionList.LeadingVisual>
                <FileMediaIcon />
              </ActionList.LeadingVisual>
              Download chart (PNG)
              <ActionList.Description variant="block">
                High-resolution image of the chart.
              </ActionList.Description>
            </ActionList.Item>
          )}
          <ActionList.Item onSelect={() => run("pdf")} disabled={busy}>
            <ActionList.LeadingVisual>
              <FileIcon />
            </ActionList.LeadingVisual>
            Download summary (PDF)
            <ActionList.Description variant="block">
              {canExportPng ? "Key stats plus the chart on one page." : "Key stats on one page."}
            </ActionList.Description>
          </ActionList.Item>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}
