const SKIP_STATUS = new Set(["disabled", "expired", "quota_exhausted", "unsupported"])

export function relayOrigin(baseUrl) {
  const value = typeof baseUrl === "string" ? baseUrl.trim() : ""
  if (!value) return ""
  let url
  try {
    url = new URL(value)
  } catch {
    return ""
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return ""
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")
  return `${url.protocol}//${url.host}${path === "/" ? "" : path}`
}

export function companyKeys(config) {
  const found = []
  for (const provider of config?.providers ?? []) {
    if (provider?.kind !== "company") continue
    const key = typeof provider.api_key === "string" ? provider.api_key : ""
    if (!key.startsWith("sk-")) continue
    if (SKIP_STATUS.has(provider.status)) continue
    const origin = relayOrigin(provider.base_url)
    if (!origin) continue
    found.push({
      key,
      origin,
      tool: provider.tool_id ?? "",
      id: provider.id ?? "",
      status: provider.status ?? "",
      updatedAt: provider.updated_at ?? "",
    })
  }
  return found
}

export async function listModelIds(origin, key, fetchImpl = fetch) {
  const ids = new Set()
  let url = `${origin.replace(/\/$/, "")}/v1/models`
  for (let page = 0; page < 20 && url; page++) {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}` },
    })
    if (!response.ok) {
      throw new Error(`GET /v1/models 失败（${response.status}）`)
    }
    const body = await response.json()
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
    for (const row of rows) {
      const id = typeof row === "string" ? row : row?.id
      if (typeof id === "string" && id) ids.add(id)
    }
    url = typeof body?.next === "string" && body.next ? body.next : ""
  }
  return [...ids]
}

export async function chooseKey(entries, fetchImpl = fetch) {
  const grouped = new Map()
  for (const entry of entries) {
    const id = `${entry.origin}\n${entry.key}`
    const current = grouped.get(id) ?? { key: entry.key, origin: entry.origin, updatedAt: "", tools: [] }
    current.tools.push(entry.tool)
    if (entry.updatedAt > current.updatedAt) current.updatedAt = entry.updatedAt
    grouped.set(id, current)
  }
  const ranked = []
  for (const item of grouped.values()) {
    const models = await listModelIds(item.origin, item.key, fetchImpl)
    ranked.push({ ...item, models })
  }
  ranked.sort((a, b) => b.models.length - a.models.length || b.updatedAt.localeCompare(a.updatedAt))
  return ranked[0] ?? null
}
