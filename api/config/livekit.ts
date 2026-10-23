import env from '#start/env'

const livekitConfig = {
  apiKey: env.get('LIVEKIT_API_KEY'),
  apiSecret: env.get('LIVEKIT_API_SECRET'),
  // The server SDK speaks HTTP(S); accept the ws(s):// URL the tutor uses too.
  url: env.get('LIVEKIT_URL').replace(/^ws/, 'http'),
  // Tutor rooms are named `tutor-<quizId>-<timestamp>` by the tutor API.
  roomPrefix: 'tutor-',
}

export default livekitConfig
