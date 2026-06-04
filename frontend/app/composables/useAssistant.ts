import { assistantAPI } from './useApi'

export type AssistantAction = {
  type: string
  label?: string
  description?: string
  payload?: Record<string, any>
  status?: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
}

export type AssistantMessage = {
  role: 'user' | 'assistant'
  content: string
  actions?: AssistantAction[]
}

function getRouteContext() {
  const route = useRoute()
  const params = route.params as Record<string, any>
  return {
    route: route.fullPath,
    drama_id: params.id ? Number(params.id) : undefined,
    episode_number: params.episodeNumber ? Number(params.episodeNumber) : undefined,
    title: typeof document !== 'undefined' ? document.title : '',
    page_text: typeof document !== 'undefined'
      ? (document.querySelector('main')?.textContent || document.body.textContent || '').slice(0, 6000)
      : '',
  }
}

export function useAssistant() {
  const open = useState('assistant:open', () => false)
  const loading = useState('assistant:loading', () => false)
  const actionLoading = useState('assistant:action-loading', () => false)
  const messages = useState<AssistantMessage[]>('assistant:messages', () => [
    {
      role: 'assistant',
      content: '你好，我是火宝短剧制作顾问。可以帮你优化提示词、梳理生成流程、分析当前页面里的项目和分镜；需要执行操作时，我会先给出待确认动作。',
    },
  ])

  async function send(content: string) {
    const text = content.trim()
    if (!text || loading.value) return
    messages.value = [...messages.value, { role: 'user', content: text }]
    loading.value = true
    try {
      const res = await assistantAPI.chat({
        messages: messages.value.map(({ role, content }) => ({ role, content })),
        context: getRouteContext(),
      })
      messages.value = [
        ...messages.value,
        {
          role: 'assistant',
          content: res.message || '',
          actions: (res.proposed_actions || []).map((action: AssistantAction) => ({ ...action, status: 'pending' })),
        },
      ]
    } catch (e: any) {
      messages.value = [...messages.value, { role: 'assistant', content: `请求失败：${e.message || '未知错误'}` }]
    } finally {
      loading.value = false
    }
  }

  async function executeAction(messageIndex: number, actionIndex: number) {
    const message = messages.value[messageIndex]
    const action = message?.actions?.[actionIndex]
    if (!action || action.status !== 'pending' || actionLoading.value) return

    actionLoading.value = true
    updateAction(messageIndex, actionIndex, { status: 'running' })
    try {
      const res = await assistantAPI.executeAction({
        action,
        context: getRouteContext(),
      })
      updateAction(messageIndex, actionIndex, { status: res.ok ? 'done' : 'failed' })
      messages.value = [
        ...messages.value,
        {
          role: 'assistant',
          content: res.message || (res.ok ? '操作已执行。' : '操作执行失败。'),
        },
      ]
    } catch (e: any) {
      updateAction(messageIndex, actionIndex, { status: 'failed' })
      messages.value = [...messages.value, { role: 'assistant', content: `执行失败：${e.message || '未知错误'}` }]
    } finally {
      actionLoading.value = false
    }
  }

  function cancelAction(messageIndex: number, actionIndex: number) {
    const action = messages.value[messageIndex]?.actions?.[actionIndex]
    if (!action || action.status !== 'pending') return
    updateAction(messageIndex, actionIndex, { status: 'cancelled' })
  }

  function updateAction(messageIndex: number, actionIndex: number, patch: Partial<AssistantAction>) {
    messages.value = messages.value.map((message, i) => {
      if (i !== messageIndex || !message.actions) return message
      return {
        ...message,
        actions: message.actions.map((action, j) => (
          j === actionIndex ? { ...action, ...patch } : action
        )),
      }
    })
  }

  function clear() {
    messages.value = [
      {
        role: 'assistant',
        content: '对话已清空。你可以继续问我提示词、分镜检查或生成流程相关问题。',
      },
    ]
  }

  return { open, loading, actionLoading, messages, send, executeAction, cancelAction, clear }
}
