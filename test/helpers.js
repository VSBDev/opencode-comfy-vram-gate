import { createServer } from "node:http"

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      try {
        resolve(raw ? JSON.parse(raw) : null)
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

function json(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

export async function startMockServices({ busy = false, freedMiB = 32_768 } = {}) {
  const state = {
    models: ["large-local-model:latest"],
    queue: busy ? { queue_running: [[1]], queue_pending: [] } : { queue_running: [], queue_pending: [] },
    totalMiB: 32_768,
    freeMiB: 7_000,
    ollamaUnloadRequests: [],
    comfyFreeRequests: 0,
  }

  const ollama = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/ps") return json(response, 200, { models: state.models.map((name) => ({ name })) })
    if (request.method === "POST" && request.url === "/api/generate") {
      const body = await readBody(request)
      state.ollamaUnloadRequests.push(body)
      if (body?.keep_alive === 0) state.models = state.models.filter((name) => name !== body.model)
      return json(response, 200, { done: true })
    }
    return json(response, 404, { error: "not found" })
  })

  const comfy = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/queue") return json(response, 200, state.queue)
    if (request.method === "GET" && request.url === "/system_stats") {
      return json(response, 200, {
        devices: [{ name: "Mock GPU", vram_total: state.totalMiB * 1024 * 1024, vram_free: state.freeMiB * 1024 * 1024 }],
      })
    }
    if (request.method === "POST" && request.url === "/free") {
      await readBody(request)
      state.comfyFreeRequests += 1
      state.freeMiB = freedMiB
      return json(response, 200, { ok: true })
    }
    return json(response, 404, { error: "not found" })
  })

  await Promise.all([
    new Promise((resolve) => ollama.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => comfy.listen(0, "127.0.0.1", resolve)),
  ])

  const closeServer = async (server) => {
    if (!server.listening) return
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  return {
    state,
    ollamaUrl: `http://127.0.0.1:${ollama.address().port}`,
    comfyUrl: `http://127.0.0.1:${comfy.address().port}`,
    async stopOllama() {
      await closeServer(ollama)
    },
    async stopComfy() {
      await closeServer(comfy)
    },
    async close() {
      await Promise.all([closeServer(ollama), closeServer(comfy)])
    },
  }
}
