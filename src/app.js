import Fastify from 'fastify'
import { SERVICE_NAME, VERSION } from './config.js'
import { metaRoutes } from './meta.js'
import { gtfsRoutes } from './routes.js'
import { defaultStore } from './store.js'

export async function buildApp({ logger, store } = {}) {
  const app = Fastify({
    logger: logger === false
      ? false
      : (logger || {
        transport: process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty' }
          : undefined
      })
  })

  app.decorate('store', store || defaultStore)

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    version: VERSION,
    timestamp: new Date().toISOString()
  }))

  await app.register(metaRoutes)
  await app.register(gtfsRoutes, { prefix: '/gtfs' })
  return app
}
