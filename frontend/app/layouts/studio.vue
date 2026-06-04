<template>
  <div class="studio-fullscreen">
    <slot />
    <AssistantBubble v-if="user" />
  </div>
</template>

<script setup>
const { user, load } = useAuth()

onMounted(() => {
  load()
})
</script>

<style scoped>
.studio-fullscreen { height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-base); }
</style>
