const ONE_M = 1_000_000

const WINDOWS = {
  "deepseek-flash-trae": ONE_M,
  "glm-5.3-trae": ONE_M,
  "glm-5.3-flashx-trae": ONE_M,
}

export function modelRecord(id, origin, providerId, npm) {
  const record = {
    id,
    providerID: providerId,
    name: id,
    api: { id, url: `${origin}/v1`, npm },
    status: "active",
  }
  const context = WINDOWS[id]
  if (context) record.limit = { context }
  return record
}
