<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { breakpointsTailwind } from '@vueuse/core'
import type { Mail, MailCollectResponse, MailCollectResult, MailSource } from '~/types'

const tabItems = [{
  label: 'All',
  value: 'all'
}, {
  label: 'Unread',
  value: 'unread'
}]
const selectedTab = ref('all')

const { data: mails, refresh: refreshMails } = await useFetch<Mail[]>('/api/mails', { default: () => [] })

const toast = useToast()

const collectOpen = ref(false)
const collecting = ref(false)
const failedResults = ref<MailCollectResult[]>([])

async function onCollect(sources: MailSource[]) {
  if (!sources.length || collecting.value) {
    return
  }

  collecting.value = true

  try {
    const response = await $fetch<MailCollectResponse>('/api/mails/collect', {
      method: 'POST',
      body: { sources }
    })

    const results = response?.results ?? []
    const succeeded = results.filter(result => result.status === 'ok')
    const failed = results.filter(result => result.status === 'error')

    failedResults.value = failed

    await refreshMails()

    const total = succeeded.reduce((sum, result) => sum + result.fetched, 0)

    toast.add({
      title: `采集完成：成功 ${succeeded.length} 个来源，失败 ${failed.length} 个来源`,
      description: failed.length
        ? `新写入 ${total} 封邮件，失败来源的详情见收件箱面板。`
        : `共写入 ${total} 封邮件。`,
      icon: failed.length ? 'i-lucide-triangle-alert' : 'i-lucide-check-circle',
      color: failed.length ? (succeeded.length ? 'warning' : 'error') : 'success'
    })

    collectOpen.value = false
  } catch (error) {
    toast.add({
      title: '采集请求失败',
      description: error instanceof Error ? error.message : String(error),
      icon: 'i-lucide-circle-x',
      color: 'error'
    })
  } finally {
    collecting.value = false
  }
}

function sourceLabel(result: MailCollectResult) {
  return result.label || result.url
}

// Filter mails based on the selected tab
const filteredMails = computed(() => {
  if (selectedTab.value === 'unread') {
    return mails.value.filter(mail => !!mail.unread)
  }

  return mails.value
})

const selectedMail = ref<Mail | null>()

const isMailPanelOpen = computed({
  get() {
    return !!selectedMail.value
  },
  set(value: boolean) {
    if (!value) {
      selectedMail.value = null
    }
  }
})

// Reset selected mail if it's not in the filtered mails
watch(filteredMails, () => {
  if (!filteredMails.value.find(mail => mail.id === selectedMail.value?.id)) {
    selectedMail.value = null
  }
})

const breakpoints = useBreakpoints(breakpointsTailwind)
const isMobile = breakpoints.smaller('lg')
</script>

<template>
  <UDashboardPanel
    id="inbox-1"
    :default-size="25"
    :min-size="20"
    :max-size="30"
    resizable
  >
    <UDashboardNavbar title="Inbox">
      <template #leading>
        <UDashboardSidebarCollapse />
      </template>
      <template #trailing>
        <UBadge :label="filteredMails.length" variant="subtle" />
      </template>

      <template #right>
        <UTabs
          v-model="selectedTab"
          :items="tabItems"
          :content="false"
          size="xs"
        />

        <UButton
          label="批量采集"
          icon="i-lucide-download"
          color="neutral"
          variant="outline"
          size="xs"
          :loading="collecting"
          @click="collectOpen = true"
        />
      </template>
    </UDashboardNavbar>

    <div v-if="failedResults.length" class="border-b border-default p-4 sm:px-6">
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="`${failedResults.length} 个来源采集失败`"
        :close="true"
        @update:open="failedResults = []"
      >
        <template #description>
          <ul class="mt-2 space-y-1">
            <li v-for="(result, index) in failedResults" :key="index" class="flex flex-wrap items-baseline gap-1 text-sm">
              <span class="font-medium break-all text-highlighted">{{ sourceLabel(result) }}</span>
              <span v-if="result.label && result.label !== result.url" class="break-all text-muted">({{ result.url }})</span>
              <span class="text-muted">— {{ result.error || '未知原因' }}</span>
            </li>
          </ul>
        </template>
      </UAlert>
    </div>

    <InboxList v-model="selectedMail" :mails="filteredMails" />
  </UDashboardPanel>

  <InboxCollectModal
    v-model:open="collectOpen"
    v-model:loading="collecting"
    @submit="onCollect"
  />

  <InboxMail v-if="selectedMail" :mail="selectedMail" @close="selectedMail = null" />
  <div v-else class="hidden lg:flex flex-1 items-center justify-center">
    <UIcon name="i-lucide-inbox" class="size-32 text-dimmed" />
  </div>

  <ClientOnly>
    <USlideover v-if="isMobile" v-model:open="isMailPanelOpen">
      <template #content>
        <InboxMail v-if="selectedMail" :mail="selectedMail" @close="selectedMail = null" />
      </template>
    </USlideover>
  </ClientOnly>
</template>
