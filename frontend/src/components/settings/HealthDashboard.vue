<script setup lang="ts">
import { ref, onMounted } from 'vue'
import api from '../../api/client'
import { useApiError } from '../../composables/useApiError'
import { useI18n } from 'vue-i18n'

interface PlatformHealth {
  platform: string
  total: number
  success_count: number
  success_rate: number
  avg_duration_ms: number
  last_error: string | null
}

interface FetchAttempt {
  adapter_type: string
  success: boolean
  error_message: string | null
  duration_ms: number
}

interface HealthLog {
  id: string
  display_name: string
  adapter_type: string
  success: boolean
  error_message: string | null
  duration_ms: number
  articles_count: number
  created_at: string
  attempts?: FetchAttempt[]
}

const { t } = useI18n()
const { describe } = useApiError()
const health = ref<PlatformHealth[]>([])
const loading = ref(false)
const error = ref('')

const expanded = ref<string | null>(null)
const logs = ref<HealthLog[]>([])
const logsLoading = ref(false)
const logsError = ref('')

onMounted(async () => {
  loading.value = true
  try {
    const { data } = await api.get('/admin/health')
    health.value = Array.isArray(data) ? data : (data.platforms || [])
  } catch (e: any) {
    error.value = describe(e)
  } finally {
    loading.value = false
  }
})

async function togglePlatform(platform: string) {
  if (expanded.value === platform) {
    expanded.value = null
    logs.value = []
    return
  }
  expanded.value = platform
  logs.value = []
  logsError.value = ''
  logsLoading.value = true
  try {
    const { data } = await api.get(`/admin/health/${platform}`, { params: { limit: 20 } })
    logs.value = (Array.isArray(data) ? data : []).map((log: any) => ({
      ...log,
      attempts: Array.isArray(log.attempts) ? log.attempts : [],
    }))
  } catch (e: any) {
    logsError.value = describe(e)
  } finally {
    logsLoading.value = false
  }
}

function successRate(p: PlatformHealth): number {
  return Math.round(p.success_rate * 100)
}

function rateBadgeClass(rate: number): string {
  if (rate >= 95) return 'badge-green'
  if (rate >= 80) return 'badge-yellow'
  return 'badge-red'
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleString()
}
</script>

<template>
  <div class="health-dashboard">
    <div v-if="loading" class="loading" role="status">{{ t('health.loading') }}</div>
    <div v-else-if="error" class="error" role="alert">{{ error }}</div>
    <div v-else-if="health.length === 0" class="empty">{{ t('health.empty') }}</div>
    <div v-for="p in health" :key="p.platform" class="platform-card">
      <div class="card-top" role="button" tabindex="0" @click="togglePlatform(p.platform)" @keydown.enter="togglePlatform(p.platform)">
        <div class="platform-name">{{ p.platform }}</div>
        <span class="rate-badge" :class="rateBadgeClass(successRate(p))">
          {{ t('health.successRate', { n: successRate(p) }) }}
        </span>
      </div>
      <div class="stats-row">
        <div class="stat">
          <span class="stat-label">{{ t('health.total') }}</span>
          <span class="stat-value">{{ p.total }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">{{ t('health.success') }}</span>
          <span class="stat-value success-val">{{ p.success_count }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">{{ t('health.failed') }}</span>
          <span class="stat-value error-val">{{ p.total - p.success_count }}</span>
        </div>
        <div class="stat">
          <span class="stat-label">{{ t('health.avgDuration') }}</span>
          <span class="stat-value">{{ p.avg_duration_ms }}ms</span>
        </div>
      </div>
      <div v-if="p.last_error" class="last-error">
        <span class="error-label">{{ t('health.lastError') }}</span>{{ p.last_error }}
      </div>
      <div v-if="expanded === p.platform" class="log-detail">
        <div v-if="logsLoading" class="loading" role="status">{{ t('health.loading') }}</div>
        <div v-else-if="logsError" class="error" role="alert">{{ logsError }}</div>
        <div v-else-if="logs.length === 0" class="empty">{{ t('health.noLogs') }}</div>
        <div v-for="log in logs" :key="log.id" class="log-entry">
          <div class="log-summary">
            <span class="log-status" :class="log.success ? 'success-val' : 'error-val'">
              {{ log.success ? t('health.attemptSuccess') : t('health.attemptFailed') }}
            </span>
            <span class="log-source">{{ log.display_name }}</span>
            <span class="log-meta">{{ log.duration_ms }}ms · {{ formatTime(log.created_at) }}</span>
          </div>
          <div v-if="log.error_message" class="last-error">
            <span class="error-label">{{ t('health.lastError') }}</span>{{ log.error_message }}
          </div>
          <ul v-if="log.attempts && log.attempts.length" class="attempt-list">
            <li v-for="(att, i) in log.attempts" :key="i" class="attempt-item">
              <span class="attempt-seq">#{{ i + 1 }}</span>
              <span class="attempt-adapter">{{ att.adapter_type }}</span>
              <span class="log-status" :class="att.success ? 'success-val' : 'error-val'">
                {{ att.success ? t('health.attemptSuccess') : t('health.attemptFailed') }}
              </span>
              <span class="log-meta">{{ att.duration_ms }}ms</span>
              <span v-if="att.error_message" class="attempt-error">{{ att.error_message }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.health-dashboard { display: flex; flex-direction: column; gap: 16px; }
.loading, .empty { color: var(--text-secondary); text-align: center; padding: 32px 0; }
.error { color: var(--error); text-align: center; padding: 16px 0; }
.platform-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
.card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; cursor: pointer; }
.platform-name { color: var(--text-primary); font-size: 14px; font-weight: 600; text-transform: capitalize; }
.rate-badge { font-size: 12px; font-weight: 600; }
.badge-green { color: var(--success); }
.badge-yellow { color: var(--warning); }
.badge-red { color: var(--error); }
.stats-row { display: flex; gap: 20px; margin-bottom: 10px; flex-wrap: wrap; }
.stat { display: flex; flex-direction: column; gap: 2px; }
.stat-label { color: var(--text-muted); font-size: 11px; }
.stat-value { color: var(--text-primary); font-size: 14px; font-weight: 600; }
.success-val { color: var(--success); }
.error-val { color: var(--error); }
.last-error { color: var(--text-secondary); font-size: 12px; margin-bottom: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.error-label { color: var(--error); }
.log-detail { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 8px; }
.log-detail .loading, .log-detail .empty { padding: 12px 0; }
.log-entry { padding: 8px 0; border-bottom: 1px dashed var(--border); }
.log-entry:last-child { border-bottom: none; }
.log-summary { display: flex; align-items: center; gap: 10px; font-size: 12px; flex-wrap: wrap; }
.log-status { font-weight: 600; }
.log-source { color: var(--text-primary); }
.log-meta { color: var(--text-muted); }
.attempt-list { list-style: none; margin: 6px 0 0; padding: 0 0 0 12px; }
.attempt-item { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; flex-wrap: wrap; }
.attempt-seq { color: var(--text-muted); }
.attempt-adapter { color: var(--text-primary); font-weight: 600; }
.attempt-error { color: var(--error); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
</style>
