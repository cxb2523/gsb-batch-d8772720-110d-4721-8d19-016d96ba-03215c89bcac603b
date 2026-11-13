<script setup lang="ts">
import type { MailSource } from '~/types'

const open = defineModel<boolean>('open', { default: false })

const emits = defineEmits<{
  submit: [sources: MailSource[]]
}>()

const loading = defineModel<boolean>('loading', { default: false })

interface SourceRow {
  url: string
  label: string
}

const rows = ref<SourceRow[]>([{ url: '', label: '' }])

// Keep the URL example in the script: vue-tsc trips over "://" inside a
// template attribute value and loses the v-for scope.
const urlPlaceholder = 'https://example.com/mails.json'

function addRow() {
  rows.value.push({ url: '', label: '' })
}

function removeRow(index: number) {
  rows.value.splice(index, 1)
  if (rows.value.length === 0) {
    addRow()
  }
}

const sources = computed<MailSource[]>(() =>
  rows.value
    .map(row => ({ url: row.url.trim(), label: row.label.trim() }))
    .filter(row => row.url !== '')
    .map(row => (row.label ? { url: row.url, label: row.label } : { url: row.url }))
)

const canSubmit = computed(() => sources.value.length > 0 && !loading.value)

function onSubmit() {
  if (!canSubmit.value) {
    return
  }

  emits('submit', sources.value)
}

// Reset the form each time the modal is opened so a previous run does not leak
watch(open, (value) => {
  if (value) {
    rows.value = [{ url: '', label: '' }]
  }
})
</script>

<template>
  <UModal
    v-model:open="open"
    title="批量采集邮件"
    description="填写外部邮件来源地址，服务端会逐个抓取并把合法邮件并入收件箱。"
  >
    <slot />

    <template #body>
      <div class="space-y-3">
        <div
          v-for="(row, index) in rows"
          :key="index"
          class="flex items-start gap-2"
        >
          <div class="grid flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <UInput
              :model-value="row.url"
              :placeholder="urlPlaceholder"
              icon="i-lucide-link"
              :disabled="loading"
              aria-label="来源地址"
              @update:model-value="value => (row.url = value)"
            />
            <UInput
              :model-value="row.label"
              placeholder="标签（可选）"
              icon="i-lucide-tag"
              :disabled="loading"
              aria-label="来源标签"
              @update:model-value="value => (row.label = value)"
            />
          </div>
          <UButton
            icon="i-lucide-trash-2"
            color="neutral"
            variant="ghost"
            :disabled="loading || rows.length === 1"
            aria-label="移除来源"
            @click="removeRow(index)"
          />
        </div>

        <UButton
          label="添加来源"
          icon="i-lucide-plus"
          color="neutral"
          variant="subtle"
          size="sm"
          :disabled="loading"
          @click="addRow"
        />

        <p class="text-sm text-muted">
          每个地址应返回邮件数组，字段与收件箱一致（id、from、subject、body、date，unread 可选）。单个来源失败不会影响其他来源。
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <UButton
          label="取消"
          color="neutral"
          variant="subtle"
          :disabled="loading"
          @click="open = false"
        />
        <UButton
          label="开始采集"
          icon="i-lucide-download"
          :loading="loading"
          :disabled="!canSubmit"
          @click="onSubmit"
        />
      </div>
    </template>
  </UModal>
</template>
