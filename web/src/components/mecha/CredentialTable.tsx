import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import { useMemo } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useI18n } from '@/i18n'
import type { CredentialStatus } from '@/lib/types'
import { fuseModel } from './Fuse'
import { StatusPill } from './StatusPill'
import { checkedLine, fundsLine, providerName, reasonsLine } from './text'

const features = tableFeatures({})
const helper = createColumnHelper<typeof features, CredentialStatus>()

export function CredentialTable({
  items,
  now,
  horizonDays,
  onOpen,
}: {
  items: CredentialStatus[]
  now: string
  horizonDays: number
  onOpen: (id: string) => void
}) {
  const i18n = useI18n()
  const { t } = i18n
  const columns = useMemo(
    () =>
      helper.columns([
        helper.display({
          id: 'status',
          header: t('filterStatus'),
          cell: ({ row }) => <StatusPill overall={row.original.result.overall} />,
        }),
        helper.display({
          id: 'label',
          header: t('label'),
          cell: ({ row }) => (
            <button
              type="button"
              className="rounded-sm text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => onOpen(row.original.credential.id)}
            >
              {row.original.credential.label}
            </button>
          ),
        }),
        helper.display({
          id: 'type',
          header: t('kind'),
          cell: ({ row }) =>
            `${providerName(row.original.credential.provider)} · ${t(`kind.${row.original.credential.kind}`)}`,
        }),
        helper.display({
          id: 'key',
          header: t('secret'),
          cell: ({ row }) => (
            <span className="font-mono text-xs">{row.original.credential.redacted}</span>
          ),
        }),
        helper.display({
          id: 'expiry',
          header: t('signal.expiry'),
          cell: ({ row }) => fuseModel(row.original, now, t, i18n.relative, horizonDays).text,
        }),
        helper.display({
          id: 'funds',
          header: t('signal.funds'),
          cell: ({ row }) => fundsLine(i18n, row.original),
        }),
        helper.display({
          id: 'why',
          header: '',
          cell: ({ row }) => (
            <span className="text-xs">{reasonsLine(i18n, row.original, now)}</span>
          ),
        }),
        helper.display({
          id: 'checked',
          header: '',
          cell: ({ row }) => (
            <span className="text-muted-foreground text-xs">
              {checkedLine(i18n, row.original, now)}
            </span>
          ),
        }),
      ]),
    [i18n, now, horizonDays, onOpen, t],
  )
  const table = useTable({ features, columns, data: items })
  return (
    <Table data-testid="credential-table">
      <TableHeader>
        {table.getHeaderGroups().map((group) => (
          <TableRow key={group.id}>
            {group.headers.map((header) => (
              <TableHead key={header.id}>
                {header.isPlaceholder ? null : <table.FlexRender header={header} />}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id} data-overall={row.original.result.overall}>
            {row.getAllCells().map((cell) => (
              <TableCell key={cell.id}>
                <table.FlexRender cell={cell} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
