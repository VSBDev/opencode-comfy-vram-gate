export class HttpError extends Error {
  constructor(message, { status, method, url, cause } = {}) {
    super(message, { cause })
    this.name = "HttpError"
    this.status = status
    this.method = method
    this.url = url
  }
}

export async function requestJson(method, url, { body, timeoutMs = 15_000 } = {}) {
  let response
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new HttpError(`${method} ${url} failed: ${error?.message || error}`, { method, url, cause: error })
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500)
    throw new HttpError(`${method} ${url} returned ${response.status}${detail ? `: ${detail}` : ""}`, {
      status: response.status,
      method,
      url,
    })
  }
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new HttpError(`${method} ${url} returned invalid JSON`, { method, url, cause: error })
  }
}

export async function waitFor(label, condition, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await condition()) return
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  const suffix = lastError ? `; last error: ${lastError.message || lastError}` : ""
  throw new Error(`Timed out waiting for ${label}${suffix}`)
}
