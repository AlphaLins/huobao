import { EventEmitter } from 'events'

export const imageEvents = new EventEmitter()
imageEvents.setMaxListeners(100)
export const taskEvents = new EventEmitter()
taskEvents.setMaxListeners(100)

export interface ImageCompleteEvent {
  id: number
  dramaId?: number | null
  characterId?: number | null
  sceneId?: number | null
  storyboardId?: number | null
  frameType?: string | null
  imageType?: string | null
  localPath: string
  status: 'completed' | 'failed'
  errorMsg?: string
}

export interface TaskEvent {
  type: 'image' | 'video' | 'tts' | 'compose' | 'merge'
  status: 'completed' | 'failed'
  id?: number
  dramaId?: number | null
  episodeId?: number | null
  storyboardId?: number | null
  characterId?: number | null
  sceneId?: number | null
  frameType?: string | null
  imageType?: string | null
  localPath?: string | null
  videoUrl?: string | null
  ttsAudioUrl?: string | null
  composedVideoUrl?: string | null
  mergedUrl?: string | null
  errorMsg?: string | null
}

export function emitTaskEvent(event: TaskEvent) {
  taskEvents.emit('event', event)
}

export function emitImageEvent(event: ImageCompleteEvent) {
  imageEvents.emit('completed', event)
  emitTaskEvent({
    type: 'image',
    status: event.status,
    id: event.id,
    dramaId: event.dramaId,
    storyboardId: event.storyboardId,
    characterId: event.characterId,
    sceneId: event.sceneId,
    frameType: event.frameType,
    imageType: event.imageType,
    localPath: event.localPath,
    errorMsg: event.errorMsg,
  })
}
