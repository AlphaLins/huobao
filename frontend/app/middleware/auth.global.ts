export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return
  if (import.meta.server) return

  const auth = useAuth()
  if (!auth.loaded.value) {
    await auth.load()
  }
  if (!auth.user.value) {
    return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`)
  }
  if ((to.path === '/settings' || to.path === '/users') && auth.user.value.role !== 'admin') {
    return navigateTo('/')
  }
})
