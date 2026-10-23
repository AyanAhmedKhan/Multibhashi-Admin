import db from '@adonisjs/lucid/services/db'
import { RoomServiceClient } from 'livekit-server-sdk'
import env from '#start/env'
import livekitConfig from '#config/livekit'
import mailService from '#services/mail_service'

type Check = { name: string; ok: boolean; ms: number; detail?: string }

async function timed(name: string, fn: () => Promise<string | undefined>): Promise<Check> {
  const start = performance.now()
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 4 s')), 4000)),
    ])
    return { name, ok: true, ms: Math.round(performance.now() - start), detail }
  } catch (error) {
    return { name, ok: false, ms: Math.round(performance.now() - start), detail: (error as Error).message }
  }
}

class HealthService {
  async checks() {
    const tutorUrl = env.get('TUTOR_API_URL')
    return Promise.all([
      timed('Database', async () => {
        await db.rawQuery('SELECT 1')
        return undefined
      }),
      timed('LiveKit', async () => {
        const rooms = await new RoomServiceClient(livekitConfig.url, livekitConfig.apiKey, livekitConfig.apiSecret).listRooms()
        return `${rooms.length} room(s) open`
      }),
      timed('Email (SMTP)', async () => mailService.verify()),
      tutorUrl
        ? timed('Tutor API', async () => {
            const res = await fetch(new URL('/health/ready', tutorUrl))
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return undefined
          })
        : Promise.resolve({ name: 'Tutor API', ok: false, ms: 0, detail: 'TUTOR_API_URL not set' }),
    ])
  }
}

export default new HealthService()
