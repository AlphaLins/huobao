<template>
  <div class="assistant">
    <button class="assistant-fab" :class="{ active: open }" title="短剧制作顾问" @click="open = !open">
      AI
    </button>

    <section v-if="open" class="assistant-panel">
      <header class="assistant-head">
        <div>
          <div class="assistant-title">短剧制作顾问</div>
          <div class="assistant-subtitle">提示词优化 · 流程指导 · 确认后执行</div>
        </div>
        <div class="assistant-actions">
          <button title="清空" @click="clear">清空</button>
          <button title="收起" @click="open = false">收起</button>
        </div>
      </header>

      <div ref="scrollEl" class="assistant-messages">
        <article v-for="(msg, msgIndex) in messages" :key="msgIndex" :class="['assistant-msg', msg.role]">
          <div class="assistant-avatar">{{ msg.role === 'user' ? '你' : '顾问' }}</div>
          <div class="assistant-content">
            <div class="assistant-bubble" v-html="renderMarkdown(msg.content)" />
            <div v-if="msg.actions?.length" class="assistant-action-list">
              <div v-for="(action, actionIndex) in msg.actions" :key="`${msgIndex}-${actionIndex}`" class="assistant-action-card">
                <div>
                  <div class="action-title">{{ action.label || action.type }}</div>
                  <div v-if="action.description" class="action-desc">{{ action.description }}</div>
                  <div class="action-status">{{ actionStatusText(action.status) }}</div>
                </div>
                <div v-if="action.status === 'pending'" class="action-buttons">
                  <button class="btn btn-primary" :disabled="actionLoading" @click="executeAction(msgIndex, actionIndex)">
                    确认执行
                  </button>
                  <button class="btn" :disabled="actionLoading" @click="cancelAction(msgIndex, actionIndex)">
                    取消
                  </button>
                </div>
              </div>
            </div>
          </div>
        </article>
        <article v-if="loading" class="assistant-msg assistant">
          <div class="assistant-avatar">顾问</div>
          <div class="assistant-content">
            <div class="assistant-bubble dim">正在思考...</div>
          </div>
        </article>
      </div>

      <form class="assistant-input" @submit.prevent="submit">
        <textarea
          v-model="draft"
          placeholder="例如：检查当前集还缺什么，或帮我优化第 3 个镜头的视频提示词"
          rows="2"
          @keydown.enter.exact.prevent="submit"
        />
        <button class="btn btn-primary" :disabled="loading || !draft.trim()">发送</button>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
const { open, loading, actionLoading, messages, send, executeAction, cancelAction, clear } = useAssistant()
const draft = ref('')
const scrollEl = ref<HTMLElement | null>(null)

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function renderInline(input: string) {
  return input
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

function renderMarkdown(input: string) {
  const escaped = escapeHtml(input || '')
  const codeBlocks: string[] = []
  const withoutBlocks = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    const index = codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`) - 1
    return `@@CODE_BLOCK_${index}@@`
  })
  const html = withoutBlocks
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n')
      if (/^#{1,3}\s+/.test(lines[0])) {
        const level = Math.min(lines[0].match(/^#+/)?.[0].length || 2, 3)
        return `<h${level}>${renderInline(lines[0].replace(/^#{1,3}\s+/, ''))}</h${level}>`
      }
      if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
        return `<ul>${lines.map(line => `<li>${renderInline(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`
      }
      if (lines.every(line => /^\s*\d+\.\s+/.test(line))) {
        return `<ol>${lines.map(line => `<li>${renderInline(line.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`
      }
      return `<p>${renderInline(lines.join('<br>'))}</p>`
    })
    .join('')
  return html.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, index) => codeBlocks[Number(index)] || '')
}

function actionStatusText(status?: string) {
  if (status === 'running') return '正在执行'
  if (status === 'done') return '已执行'
  if (status === 'failed') return '执行失败'
  if (status === 'cancelled') return '已取消'
  return '等待你确认'
}

async function submit() {
  const text = draft.value
  draft.value = ''
  await send(text)
}

watch(messages, async () => {
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}, { deep: true })
</script>

<style scoped>
.assistant {
  position: fixed;
  right: 22px;
  bottom: 22px;
  z-index: 80;
}
.assistant-fab {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  border: 1px solid rgba(76,125,255,.35);
  background: var(--accent);
  color: white;
  font-weight: 800;
  box-shadow: var(--shadow-elevated);
  cursor: pointer;
}
.assistant-fab.active {
  transform: scale(.96);
}
.assistant-panel {
  position: absolute;
  right: 0;
  bottom: 64px;
  width: min(440px, calc(100vw - 32px));
  height: min(650px, calc(100dvh - 96px));
  max-height: calc(100dvh - 96px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-elevated);
}
.assistant-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
.assistant-title {
  font-size: 14px;
  font-weight: 700;
}
.assistant-subtitle {
  margin-top: 2px;
  color: var(--text-3);
  font-size: 11px;
}
.assistant-actions,
.action-buttons {
  flex: 0 0 auto;
  display: flex;
  gap: 6px;
}
.assistant-actions button {
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-2);
  border-radius: var(--radius);
  padding: 5px 8px;
  cursor: pointer;
  font-size: 12px;
}
.assistant-messages {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.assistant-messages::-webkit-scrollbar {
  width: 8px;
}
.assistant-messages::-webkit-scrollbar-track {
  background: transparent;
}
.assistant-messages::-webkit-scrollbar-thumb {
  background: var(--bg-3);
  border-radius: 99px;
}
.assistant-messages::-webkit-scrollbar-thumb:hover {
  background: var(--border-strong);
}
.assistant-msg {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 9px;
  min-width: 0;
  max-width: 100%;
}
.assistant-msg.user {
  grid-template-columns: minmax(0, 1fr) 34px;
}
.assistant-msg.user .assistant-avatar {
  grid-column: 2;
  grid-row: 1;
}
.assistant-msg.user .assistant-content {
  grid-column: 1;
  grid-row: 1;
}
.assistant-msg.user .assistant-bubble {
  background: var(--accent-bg);
  border-color: rgba(76,125,255,.22);
}
.assistant-avatar {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--bg-2);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 700;
}
.assistant-content {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
}
.assistant-bubble {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-word;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-base);
  color: var(--text-1);
  font-size: 13px;
  line-height: 1.6;
}
.assistant-bubble :deep(p) {
  max-width: 100%;
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.assistant-bubble :deep(p:last-child) { margin-bottom: 0; }
.assistant-bubble :deep(ul),
.assistant-bubble :deep(ol) {
  max-width: 100%;
  margin: 0 0 8px 18px;
  padding: 0;
  overflow-wrap: anywhere;
}
.assistant-bubble :deep(a) {
  overflow-wrap: anywhere;
  word-break: break-word;
}
.assistant-bubble :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 10px;
  border-radius: var(--radius);
  background: var(--bg-3);
}
.assistant-bubble :deep(code) {
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bg-3);
}
.assistant-bubble :deep(pre code) {
  display: block;
  width: max-content;
  min-width: 100%;
  white-space: pre;
  overflow-wrap: normal;
}
.assistant-action-list {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}
.assistant-action-card {
  display: grid;
  gap: 10px;
  padding: 10px;
  border: 1px solid rgba(76,125,255,.25);
  border-radius: var(--radius);
  background: var(--bg-2);
}
.action-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-1);
}
.action-desc,
.action-status {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-3);
}
.assistant-input {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid var(--border);
}
.assistant-input textarea {
  resize: vertical;
  min-height: 42px;
  max-height: 220px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-base);
  color: var(--text-0);
  font: inherit;
  line-height: 1.55;
  overflow-y: auto;
}
.dim {
  color: var(--text-3);
}
@media (max-width: 640px) {
  .assistant {
    right: 14px;
    bottom: 14px;
  }
  .assistant-panel {
    position: fixed;
    left: 10px;
    right: 10px;
    top: max(10px, env(safe-area-inset-top));
    bottom: 76px;
    width: auto;
    height: auto;
    max-height: calc(100dvh - 96px);
  }
}
</style>
