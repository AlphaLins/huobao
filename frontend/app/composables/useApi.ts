const BASE = '/api/v1'

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body || '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await resp.json()
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
      if (resp.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        const redirect = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.href = `/login?redirect=${redirect}`
      }
      throw new Error(json.message || `${resp.status}`)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

async function formReq<T = any>(path: string, form: FormData): Promise<T> {
  const start = performance.now()
  console.log(`%c[API] %cPOST %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', form)
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: form, credentials: 'same-origin' })
  const json = await resp.json()
  const ms = Math.round(performance.now() - start)
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', json.message || '')
    throw new Error(json.message || `${resp.status}`)
  }
  console.log(`%c[API] %cPOST ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
  return json.data ?? json
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const authAPI = {
  me: () => api.get('/auth/me'),
  login: (data: { access_password: string; username: string; password: string }) => api.post('/auth/login', data),
  logout: () => api.post('/auth/logout', {}),
  users: () => api.get('/auth/users'),
  createUser: (data: any) => api.post('/auth/users', data),
  updateUser: (id: number, data: any) => api.put(`/auth/users/${id}`, data),
}

export const assistantAPI = {
  chat: (data: any) => api.post('/assistant/chat', data),
  executeAction: (data: any) => api.post('/assistant/actions/execute', data),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  clearModule: (id: number, module: string) => api.post(`/episodes/${id}/clear-module`, { module }),
  exportGeneratedVideos: async (id: number) => {
    const resp = await fetch(`${BASE}/episodes/${id}/export-generated-videos`)
    if (!resp.ok) {
      const text = await resp.text()
      try {
        const json = JSON.parse(text)
        throw new Error(json.message || text || `${resp.status}`)
      } catch (err: any) {
        if (err?.message && err.message !== text) throw err
        throw new Error(text || `${resp.status}`)
      }
    }
    const disposition = resp.headers.get('content-disposition') || ''
    const encodedMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i)
    const match = disposition.match(/filename="?([^";]+)"?/i)
    return {
      blob: await resp.blob(),
      filename: encodedMatch?.[1] ? decodeURIComponent(encodedMatch[1]) : (match?.[1] || `generated-videos-${id}.zip`),
    }
  },
  saveGeneratedVideos: (id: number) => api.post(`/episodes/${id}/save-generated-videos`, {}),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  generateTTS: (id: number, data?: any) => api.post(`/storyboards/${id}/generate-tts`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
}

export const characterAPI = {
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  voiceSample: (id: number, episodeId: number) => api.post(`/characters/${id}/generate-voice-sample`, { episode_id: episodeId }),
  generateImage: (id: number, episodeId: number) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId }),
  batchImages: (ids: number[], episodeId: number) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId }),
}

export const sceneAPI = {
  generateImage: (id: number, episodeId: number) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId }),
}

export const imageAPI = {
  generate: (d: any) => api.post('/images', d),
  get: (id: number) => api.get(`/images/${id}`),
  syncResult: (id: number) => api.post(`/images/${id}/sync-result`),
  previewPrompt: (d: any) => api.post('/images/preview-prompt', d),
  refinePreview: (d: any) => api.post('/images/refine-preview', d),
  refine: (d: any) => api.post('/images/refine', d),
  setCurrent: (d: any) => api.post('/images/set-current', d),
  latest: (params: { drama_id?: number; storyboard_id?: number; scene_id?: number; character_id?: number; frame_type?: string }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    if (params?.scene_id) query.set('scene_id', String(params.scene_id))
    if (params?.character_id) query.set('character_id', String(params.character_id))
    if (params?.frame_type) query.set('frame_type', params.frame_type)
    return api.get(`/images/latest${query.size ? `?${query.toString()}` : ''}`)
  },
  list: (params?: { drama_id?: number; storyboard_id?: number; scene_id?: number; character_id?: number; frame_type?: string; image_type?: string; status?: string; limit?: number }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    if (params?.scene_id) query.set('scene_id', String(params.scene_id))
    if (params?.character_id) query.set('character_id', String(params.character_id))
    if (params?.frame_type) query.set('frame_type', params.frame_type)
    if (params?.image_type) query.set('image_type', params.image_type)
    if (params?.status) query.set('status', params.status)
    if (params?.limit) query.set('limit', String(params.limit))
    return api.get(`/images${query.size ? `?${query.toString()}` : ''}`)
  },
}

export const uploadAPI = {
  episodeDocument: (data: { episode_id: number; field?: 'content' | 'script_content'; file: File }) => {
    const form = new FormData()
    form.append('episode_id', String(data.episode_id))
    form.append('field', data.field || 'content')
    form.append('file', data.file)
    return formReq('/upload/episode-document', form)
  },
  moduleImage: (data: { target_type: 'character' | 'scene' | 'storyboard'; target_id: number; frame_type?: string; file: File }) => {
    const form = new FormData()
    form.append('target_type', data.target_type)
    form.append('target_id', String(data.target_id))
    if (data.frame_type) form.append('frame_type', data.frame_type)
    form.append('file', data.file)
    return formReq('/upload/module-image', form)
  },
  storyboardImage: (data: { storyboard_id: number; frame_type: string; file: File }) => {
    const form = new FormData()
    form.append('storyboard_id', String(data.storyboard_id))
    form.append('frame_type', data.frame_type)
    form.append('file', data.file)
    return formReq('/upload/storyboard-image', form)
  },
}
export const gridAPI = {
  prompt: (d: any) => api.post('/grid/prompt', d),
  generate: (d: any) => api.post('/grid/generate', d),
  status: (id: number) => api.get(`/grid/status/${id}`),
  split: (d: any) => api.post('/grid/split', d),
}
export const videoAPI = {
  generate: (d: any) => api.post('/videos', d),
  previewPrompt: (d: any) => api.post('/videos/preview-prompt', d),
  get: (id: number) => api.get(`/videos/${id}`),
  setCurrent: (d: any) => api.post('/videos/set-current', d),
  list: (params?: { drama_id?: number; storyboard_id?: number; status?: string; provider?: string; reference_mode?: string; limit?: number }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    if (params?.status) query.set('status', params.status)
    if (params?.provider) query.set('provider', params.provider)
    if (params?.reference_mode) query.set('reference_mode', params.reference_mode)
    if (params?.limit) query.set('limit', String(params.limit))
    return api.get(`/videos${query.size ? `?${query.toString()}` : ''}`)
  },
}
export const composeAPI = {
  shot: (id: number) => api.post(`/compose/storyboards/${id}/compose`),
  all: (epId: number) => api.post(`/compose/episodes/${epId}/compose-all`),
  status: (epId: number) => api.get(`/compose/episodes/${epId}/compose-status`),
}
export const mergeAPI = {
  merge: (epId: number) => api.post(`/merge/episodes/${epId}/merge`),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
  huobaoPreset: (apiKey: string) => api.post('/ai-configs/huobao-preset', { api_key: apiKey }),
}

export const agentConfigAPI = {
  list: () => api.get('/agent-configs'),
  get: (id: number) => api.get(`/agent-configs/${id}`),
  create: (d: any) => api.post('/agent-configs', d),
  update: (id: number, d: any) => api.put(`/agent-configs/${id}`, d),
  del: (id: number) => api.del(`/agent-configs/${id}`),
}

export const agentPresetAPI = {
  list: () => api.get('/agent-presets'),
  default: () => api.get('/agent-presets/default'),
  create: (d: any) => api.post('/agent-presets', d),
  update: (id: number, d: any) => api.put(`/agent-presets/${id}`, d),
  duplicate: (id: number, d?: any) => api.post(`/agent-presets/${id}/duplicate`, d || {}),
  setDefault: (id: number) => api.post(`/agent-presets/${id}/set-default`, {}),
  del: (id: number) => api.del(`/agent-presets/${id}`),
}

export const skillsAPI = {
  list: () => api.get('/skills'),
  get: (id: string) => api.get(`/skills/${id}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string) => api.put(`/skills/${id}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const voicesAPI = {
  list: (provider?: string) => api.get(`/ai-voices${provider ? `?provider=${provider}` : ''}`),
  sync: () => api.post('/ai-voices/sync', {}),
}
