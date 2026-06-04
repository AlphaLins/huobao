<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">用户管理</h1>
        <p class="page-desc">为熟人创建独立账号，每个账号只看到自己的项目。</p>
      </div>
    </div>

    <section class="card form-card">
      <div class="field-row">
        <label class="field"><span class="field-label">账号</span><input v-model="form.username" class="input" placeholder="user01" /></label>
        <label class="field"><span class="field-label">显示名</span><input v-model="form.display_name" class="input" placeholder="朋友昵称" /></label>
        <label class="field"><span class="field-label">密码</span><input v-model="form.password" class="input" type="password" placeholder="至少 6 位" /></label>
        <label class="field">
          <span class="field-label">角色</span>
          <select v-model="form.role" class="input">
            <option value="user">普通用户</option>
            <option value="admin">管理员</option>
          </select>
        </label>
      </div>
      <button class="btn btn-primary" @click="create">创建账号</button>
    </section>

    <section class="card table-card">
      <div v-for="u in users" :key="u.id" class="user-row">
        <div>
          <div class="name">{{ u.display_name || u.username }}</div>
          <div class="meta">{{ u.username }} · {{ u.role }}</div>
        </div>
        <span :class="['tag', u.status === 'active' ? 'tag-success' : 'tag-error']">{{ u.status }}</span>
        <button class="btn btn-ghost btn-sm" @click="toggleStatus(u)">{{ u.status === 'active' ? '禁用' : '启用' }}</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { authAPI } from '~/composables/useApi'

const users = ref<any[]>([])
const form = reactive({ username: '', display_name: '', password: '', role: 'user' })

async function load() {
  try { users.value = await authAPI.users() } catch (e: any) { toast.error(e.message) }
}

async function create() {
  try {
    await authAPI.createUser(form)
    toast.success('账号已创建')
    form.username = ''
    form.display_name = ''
    form.password = ''
    form.role = 'user'
    await load()
  } catch (e: any) {
    toast.error(e.message)
  }
}

async function toggleStatus(u: any) {
  try {
    await authAPI.updateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })
    await load()
  } catch (e: any) {
    toast.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.page { padding: 28px 48px 40px; overflow-y: auto; height: 100%; }
.page-head { margin-bottom: 20px; }
.page-title { font-size: 24px; font-weight: 700; }
.page-desc { margin-top: 4px; color: var(--text-2); font-size: 13px; }
.form-card, .table-card { padding: 18px; margin-bottom: 18px; }
.field-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; font-weight: 600; color: var(--text-1); }
.user-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.user-row:last-child { border-bottom: 0; }
.name { font-size: 14px; font-weight: 600; }
.meta { margin-top: 3px; color: var(--text-3); font-size: 12px; }
@media (max-width: 900px) { .field-row { grid-template-columns: 1fr; } }
</style>
