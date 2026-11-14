import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { useI18n } from '@/i18n'
import type { CredentialStatus } from '@/lib/types'
import { StatusPill } from './StatusPill'
import { providerName } from './text'

export interface PaletteAction {
  id: string
  label: string
  run: () => void
}

export function CommandPalette({
  open,
  onOpenChange,
  items,
  actions,
  onOpen,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: CredentialStatus[]
  actions: PaletteAction[]
  onOpen: (id: string) => void
}) {
  const { t } = useI18n()
  const close = (fn: () => void) => () => {
    onOpenChange(false)
    fn()
  }
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('commandPalette')}
      description={t('commandPlaceholder')}
    >
      <Command>
        <CommandInput placeholder={t('commandPlaceholder')} />
        <CommandList>
          <CommandEmpty>{t('commandEmpty')}</CommandEmpty>
          <CommandGroup heading={t('commandActions')}>
            {actions.map((a) => (
              <CommandItem key={a.id} value={`action ${a.label}`} onSelect={close(a.run)}>
                {a.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading={t('commandCredentials')}>
            {items.map((i) => (
              <CommandItem
                key={i.credential.id}
                value={`${i.credential.label} ${i.credential.redacted} ${i.credential.provider} ${i.credential.tags.join(' ')}`}
                onSelect={close(() => onOpen(i.credential.id))}
              >
                <StatusPill overall={i.result.overall} />
                <span className="truncate">{i.credential.label}</span>
                <span className="ml-auto text-muted-foreground text-xs">
                  {providerName(i.credential.provider)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
