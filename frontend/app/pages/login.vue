<template>
  <div class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <div>
        <div class="kicker">Huobao Shorts</div>
        <h1>登录火宝短剧</h1>
        <p>输入访问码和账号后继续使用工作台。</p>
      </div>

      <label class="field">
        <span>访问码</span>
        <input v-model="form.accessPassword" class="input" type="password" autocomplete="current-password" required />
      </label>
      <label class="field">
        <span>账号</span>
        <input v-model="form.username" class="input" autocomplete="username" required />
      </label>
      <label class="field">
        <span>密码</span>
        <input v-model="form.password" class="input" type="password" autocomplete="current-password" required />
      </label>

      <button class="btn btn-primary login-btn" :disabled="loading">
        {{ loading ? '登录中...' : '登录' }}
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'

definePageMeta({ layout: false })

const route = useRoute()
const auth = useAuth()
const loading = ref(false)
const form = reactive({
  accessPassword: '',
  username: 'admin',
  password: '',
})

async function submit() {
  loading.value = true
  try {
    await auth.login(form.accessPassword, form.username, form.password)
    await navigateTo(String(route.query.redirect || '/'))
  } catch (e: any) {
    toast.error(e.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg-base);
}
.login-card {
  width: min(420px, 100%);
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 32px;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-elevated);
}
.kicker {
  font-size: 12px;
  color: var(--accent);
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
}
h1 {
  margin: 6px 0 4px;
  font-size: 24px;
}
p {
  color: var(--text-2);
  font-size: 13px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
}
.login-btn {
  justify-content: center;
  min-height: 40px;
}
</style>
