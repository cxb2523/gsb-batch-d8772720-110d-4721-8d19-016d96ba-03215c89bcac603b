import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import type { Api } from '@/lib/api'
import type { EnvEntry, LinkCandidate } from '@/lib/types'
import { useToast } from './Toaster'
import { providerName } from './text'

/**
 * .env import: the pasted content stays in this component only; the preview (redacted) and
 * the import are uncached mutations, and the server keeps nothing in between.
 */
export function EnvImportPanel({ api, onDone }: { api: Api; onDone: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const qc = useQueryClient()
  const id = useId()
  const [content, setContent] = useState('')
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const preview = useMutation({
    mutationFn: () => api.envPreview(content),
    gcTime: 0,
    onSuccess: (r) => setChosen(new Set(r.entries.filter((e) => e.importable).map((e) => e.index))),
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  const run = useMutation({
    mutationFn: () => api.envImport(content, [...chosen]),
    gcTime: 0,
    onSuccess: (r) => {
      toast(t('envImported', { count: r.results.filter((x) => x.ok).length }))
      void qc.invalidateQueries({ queryKey: ['credentials'] })
      setContent('')
      onDone()
    },
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  const entries: EnvEntry[] = preview.data?.entries ?? []
  return (
    <div className="space-y-3" data-testid="env-panel">
      <p className="text-muted-foreground text-sm">{t('envHint')}</p>
      <Label htmlFor={`${id}-env`} className="sr-only">
        .env
      </Label>
      <Textarea
        id={`${id}-env`}
        value={content}
        onChange={(e) => {
          setContent(e.target.value)
          preview.reset()
        }}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        data-1p-ignore="true"
        data-lpignore="true"
        className="h-28 font-mono text-xs"
      />
      <Button
        type="button"
        variant="outline"
        disabled={!content.trim() || preview.isPending}
        onClick={() => preview.mutate()}
      >
        {t('envPreview')}
      </Button>
      {preview.isSuccess && entries.length === 0 && <p className="text-sm">{t('envNothing')}</p>}
      {entries.length > 0 && (
        <ul className="space-y-1" aria-label={t('envPreview')}>
          {entries.map((e) => (
            <li key={e.index}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={!e.importable}
                  checked={chosen.has(e.index)}
                  onChange={(ev) =>
                    setChosen((s) => {
                      const next = new Set(s)
                      if (ev.target.checked) next.add(e.index)
                      else next.delete(e.index)
                      return next
                    })
                  }
                />
                <span className="font-medium">{e.name}</span>
                <span className="font-mono text-muted-foreground text-xs">{e.redacted}</span>
                <span className="ml-auto text-muted-foreground text-xs">
                  {e.duplicate_of
                    ? t('envDuplicate')
                    : !e.importable
                      ? t('envNotImportable')
                      : `${e.provider ? providerName(e.provider) : '?'} · ${e.kind ? t(`kind.${e.kind}`) : '?'}`}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 0 && (
        <Button
          type="button"
          disabled={chosen.size === 0 || run.isPending}
          onClick={() => run.mutate()}
        >
          {t('envImport', { count: chosen.size })}
        </Button>
      )}
    </div>
  )
}

const TOOL_LABEL: Record<LinkCandidate['tool'], string> = {
  codex: 'Codex CLI',
  'claude-code': 'Claude Code',
  'gemini-cli': 'Gemini CLI',
}

export function LinkPanel({ api, onDone }: { api: Api; onDone: () => void }) {
  const { t } = useI18n()
  const toast = useToast()
  const qc = useQueryClient()
  const id = useId()
  const [tool, setTool] = useState<LinkCandidate['tool']>('codex')
  const [path, setPath] = useState('')
  const candidates = useQuery({ queryKey: ['linked-candidates'], queryFn: api.linkCandidates })
  const link = useMutation({
    mutationFn: (args: { tool: string; path?: string }) => api.link(args.tool, args.path),
    onSuccess: (item) => {
      toast(t('linked', { label: item.credential.label }))
      void qc.invalidateQueries({ queryKey: ['credentials'] })
      onDone()
    },
    onError: (e: Error) => toast(t('failed', { message: e.message }), 'error'),
  })
  return (
    <div className="space-y-3" data-testid="link-panel">
      <p className="text-muted-foreground text-sm">{t('linkHint')}</p>
      <ul className="space-y-2">
        {(candidates.data?.candidates ?? []).map((c) => (
          <li key={c.tool} className="flex items-center gap-2 text-sm">
            <span className="font-medium">{TOOL_LABEL[c.tool]}</span>
            <span className="truncate font-mono text-muted-foreground text-xs">{c.path}</span>
            <span className="text-xs">{c.exists ? t('linkFound') : t('linkMissing')}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={!c.exists || link.isPending}
              onClick={() => link.mutate({ tool: c.tool })}
            >
              {t('link')}
            </Button>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[auto_1fr_auto] items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-tool`}>{t('kind')}</Label>
          <select
            id={`${id}-tool`}
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={tool}
            onChange={(e) => setTool(e.target.value as LinkCandidate['tool'])}
          >
            {(Object.keys(TOOL_LABEL) as LinkCandidate['tool'][]).map((k) => (
              <option key={k} value={k}>
                {TOOL_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-path`}>{t('linkPath')}</Label>
          <Input
            id={`${id}-path`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        <Button
          type="button"
          disabled={!path.trim() || link.isPending}
          onClick={() => link.mutate({ tool, path })}
        >
          {t('link')}
        </Button>
      </div>
    </div>
  )
}
