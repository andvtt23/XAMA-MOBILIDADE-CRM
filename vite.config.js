import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { createAIHttpMiddleware } from './server/aiHttp.js'

function localAIPlugin() {
  return {
    name: 'xama-local-ai-api',
    configureServer(server) {
      server.middlewares.use(createAIHttpMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(createAIHttpMiddleware())
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localAIPlugin()],
})
