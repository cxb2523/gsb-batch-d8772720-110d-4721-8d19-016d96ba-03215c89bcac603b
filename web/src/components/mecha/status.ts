import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  HardDrive,
  type LucideIcon,
  OctagonX,
} from 'lucide-react'
import type { Overall } from '@/lib/types'

/** Every state has an icon *and* a text; colour is never the only signal. */
export const STATUS: Record<Overall, { icon: LucideIcon; tone: string; dot: string; bar: string }> =
  {
    green: {
      icon: CheckCircle2,
      tone: 'text-emerald-700 bg-emerald-500/10 ring-emerald-600/30 dark:text-emerald-300',
      dot: 'bg-emerald-500',
      bar: 'bg-emerald-500',
    },
    amber: {
      icon: AlertTriangle,
      tone: 'text-amber-800 bg-amber-500/10 ring-amber-600/30 dark:text-amber-300',
      dot: 'bg-amber-500',
      bar: 'bg-amber-500',
    },
    red: {
      icon: OctagonX,
      tone: 'text-red-700 bg-red-500/10 ring-red-600/30 dark:text-red-300',
      dot: 'bg-red-500',
      bar: 'bg-red-500',
    },
    grey: {
      icon: CircleHelp,
      tone: 'text-zinc-700 bg-zinc-500/10 ring-zinc-500/30 dark:text-zinc-300',
      dot: 'bg-zinc-500',
      bar: 'bg-zinc-500',
    },
    local: {
      icon: HardDrive,
      tone: 'text-sky-800 bg-sky-500/10 ring-sky-600/30 dark:text-sky-300',
      dot: 'bg-sky-500',
      bar: 'bg-sky-500',
    },
  }

export const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  xai: 'xAI',
  openrouter: 'OpenRouter',
}
