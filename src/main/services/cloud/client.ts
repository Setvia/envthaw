export class CloudError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface RequestOptions {
  body?: unknown
  token?: string
  timeoutMs?: number
}

/** Thin fetch wrapper for the EnvThaw cloud API (v1). */
export class CloudClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {}
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.token) headers.authorization = `Bearer ${options.token}`

    let response: Response
    try {
      response = await fetch(this.url(path), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000)
      })
    } catch (error) {
      throw new CloudError(0, 'network_error', `无法连接云服务（${this.baseUrl}）：${(error as Error).message}`)
    }

    const text = await response.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } } | null)?.error
      throw new CloudError(response.status, error?.code ?? 'request_failed', error?.message ?? `请求失败（HTTP ${response.status}）`)
    }
    return payload as T
  }

  async upload(url: string, bytes: Buffer): Promise<void> {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes,
      signal: AbortSignal.timeout(20000)
    })
    if (response.status !== 204) {
      throw new CloudError(response.status, 'upload_failed', `上传失败（HTTP ${response.status}）`)
    }
  }
}
