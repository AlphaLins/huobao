import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { imageEvents, taskEvents, type ImageCompleteEvent, type TaskEvent } from '../utils/events.js'

const app = new Hono()

// GET /events/images?drama_id=3
app.get('/images', (c) => {
  const dramaId = Number(c.req.query('drama_id') || 0)

  return streamSSE(c, async (stream) => {
    const handler = (event: ImageCompleteEvent) => {
      if (dramaId && event.dramaId !== dramaId) return
      stream.writeSSE({ data: JSON.stringify(event), event: 'image' })
    }
    imageEvents.on('completed', handler)

    try {
      // keepalive ping every 15s
      while (true) {
        await stream.sleep(15000)
        stream.writeSSE({ data: '', event: 'ping' })
      }
    } finally {
      imageEvents.off('completed', handler)
    }
  })
})

// GET /events/tasks?drama_id=3
app.get('/tasks', (c) => {
  const dramaId = Number(c.req.query('drama_id') || 0)

  return streamSSE(c, async (stream) => {
    const handler = (event: TaskEvent) => {
      if (dramaId && event.dramaId !== dramaId) return
      stream.writeSSE({ data: JSON.stringify(event), event: 'task' })
    }
    taskEvents.on('event', handler)

    try {
      while (true) {
        await stream.sleep(15000)
        stream.writeSSE({ data: '', event: 'ping' })
      }
    } finally {
      taskEvents.off('event', handler)
    }
  })
})

export default app
