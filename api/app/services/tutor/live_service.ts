import { RoomServiceClient } from 'livekit-server-sdk'
import AiTutorChat from '#models/ai_tutor_chat'
import ApiException from '#exceptions/api_exception'
import livekitConfig from '#config/livekit'
import auditService from '#services/audit_service'
import type { Actor } from '#services/actor'

const client = () => new RoomServiceClient(livekitConfig.url, livekitConfig.apiKey, livekitConfig.apiSecret)

function isTutorRoom(name: string) {
  return name.startsWith(livekitConfig.roomPrefix)
}

class LiveService {
  /** Tutor rooms open in LiveKit now, matched to their class rows. */
  async list() {
    const rooms = (await client().listRooms()).filter((room) => isTutorRoom(room.name))
    const chats = rooms.length
      ? await AiTutorChat.query().whereIn(
          'room_name',
          rooms.map((r) => r.name)
        )
      : []
    return Promise.all(
      rooms.map(async (room) => {
        const participants = await client()
          .listParticipants(room.name)
          .catch(() => [])
        const chat = chats.find((c) => c.roomName === room.name)
        return {
          room: room.name,
          createdAt: Number(room.creationTime) ? new Date(Number(room.creationTime) * 1000) : null,
          participants: participants.map((p) => ({
            identity: p.identity,
            // The tutor agent joins as an agent participant (kind 4 = AGENT).
            isAgent: Number(p.kind) === 4 || p.identity.startsWith('agent'),
            joinedAt: Number(p.joinedAt) ? new Date(Number(p.joinedAt) * 1000) : null,
          })),
          class: chat
            ? {
                id: chat.id,
                userId: chat.userId,
                topic: chat.lessonTopic,
                status: chat.status,
                totalMinutes: chat.totalMinutes,
                remainingMinutes: chat.remainingMinutes,
              }
            : null,
        }
      })
    )
  }

  /**
   * Ends a live class by closing its room. The agent treats it like the learner leaving:
   * it saves the class state and memory, and the learner can resume with the minutes left.
   */
  async end(actor: Actor, roomName: string, reason: string) {
    if (typeof roomName !== 'string' || !isTutorRoom(roomName)) {
      throw new ApiException(422, 'Not an AI tutor room')
    }
    const chat = await AiTutorChat.query().where('room_name', roomName).first()
    try {
      await client().deleteRoom(roomName)
    } catch (error) {
      await auditService.record({
        actor,
        action: 'tutor.live.ended',
        outcome: 'failure',
        targetType: 'room',
        targetId: roomName,
        reason,
        metadata: { error: (error as Error).message },
      })
      throw new ApiException(502, 'LiveKit did not close the room. It may have already ended.')
    }
    await auditService.record({
      actor,
      action: 'tutor.live.ended',
      targetType: 'room',
      targetId: roomName,
      reason,
      metadata: chat ? { class_id: chat.id, user_id: chat.userId } : null,
    })
  }
}

export default new LiveService()
