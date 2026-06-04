import { authAPI } from './useApi'

type AuthUser = {
  id: number
  username: string
  displayName?: string | null
  display_name?: string | null
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
}

export function useAuth() {
  const user = useState<AuthUser | null>('auth:user', () => null)
  const loaded = useState<boolean>('auth:loaded', () => false)

  async function load() {
    try {
      user.value = await authAPI.me()
    } catch {
      user.value = null
    } finally {
      loaded.value = true
    }
    return user.value
  }

  async function login(accessPassword: string, username: string, password: string) {
    const res = await authAPI.login({ access_password: accessPassword, username, password })
    user.value = res.user
    loaded.value = true
    return user.value
  }

  async function logout() {
    try {
      await authAPI.logout()
    } finally {
      user.value = null
      loaded.value = true
      await navigateTo('/login')
    }
  }

  return {
    user,
    loaded,
    isAdmin: computed(() => user.value?.role === 'admin'),
    load,
    login,
    logout,
  }
}
