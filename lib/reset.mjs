import { TOOLS } from "./paths.mjs"

export function relayHosts(config) {
  const hosts = new Set()
  for (const provider of config?.providers ?? []) {
    if (provider?.kind !== "company" || typeof provider.base_url !== "string") continue
    try {
      const host = new URL(provider.base_url).host
      if (host) hosts.add(host)
    } catch { /* 没有下发地址的记录不参与清理 */ }
  }
  return [...hosts]
}

const OPENCODE_OFFICIAL = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'

export function resetDockConfig(config, tools = TOOLS) {
  const next = structuredClone(config)
  next.current ??= {}
  next.company_pins ??= {}
  for (const tool of tools) {
    next.current[tool] = null
    delete next.company_pins[tool]
  }
  return next
}

export function dockMarker(text) {
  const line = String(text).split(/\r?\n/, 1)[0]
  const matched = /^# asteria_dock provider=\S+ prev=(\{.*\})\s*$/.exec(line)
  if (!matched) return null
  return JSON.parse(matched[1])
}

function stripMarker(text) {
  return String(text).replace(/^# asteria_dock[^\n]*\n/, "")
}

function hasRelay(text, hosts = []) {
  return hosts.some((host) => String(text).includes(host)) || /sk-[A-Za-z0-9_-]{8,}/.test(String(text))
}

export function resetOpenCode(text, hosts = []) {
  const raw = String(text ?? "").trim()
  if (!raw) return OPENCODE_OFFICIAL
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    if (!hasRelay(raw, hosts)) return text
    throw new Error("OpenCode 配置不是 JSON，没法安全清掉 Asteria")
  }
  const providers = data.providers
  if (providers && typeof providers === "object") delete providers.asteria
  delete data.asteria_dock
  if (typeof data.model === "string" && data.model.startsWith("asteria/")) delete data.model
  if (typeof data.small_model === "string" && data.small_model.startsWith("asteria/")) delete data.small_model
  const leftover = Object.keys(data).filter((key) => key !== "$schema")
  if (leftover.length === 0) return OPENCODE_OFFICIAL
  return `${JSON.stringify(data, null, 2)}\n`
}

export function resetPi(settingsText, modelsText) {
  const models = modelsText?.trim() ? JSON.parse(modelsText) : { providers: {} }
  const prev = models.asteria_dock?.prev ?? {}
  delete models.asteria_dock
  if (models.providers && typeof models.providers === "object") delete models.providers.asteria
  const settings = settingsText?.trim() ? JSON.parse(settingsText) : {}
  if (settings.defaultProvider === "asteria") {
    if (!prev["settings.defaultProvider"]) {
      throw new Error("Pi 没有 Dock 记下的官方配置，不能重置")
    }
    settings.defaultProvider = prev["settings.defaultProvider"]
    if (prev["settings.defaultModel"]) settings.defaultModel = prev["settings.defaultModel"]
    else delete settings.defaultModel
  }
  return {
    settings: `${JSON.stringify(settings, null, 2)}\n`,
    models: `${JSON.stringify(models, null, 2)}\n`,
  }
}

function tomlSections(text) {
  const lines = stripMarker(text).split(/\r?\n/)
  const sections = [{ name: "", lines: [] }]
  for (const line of lines) {
    const header = /^\[(.+)]$/.exec(line.trim())
    if (header) sections.push({ name: header[1], lines: [line] })
    else sections.at(-1).lines.push(line)
  }
  return sections
}

function joinSections(sections) {
  return sections
    .filter((section) => section.lines.some((line) => line.trim()))
    .map((section) => section.lines.join("\n").replace(/\n+$/, ""))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n"
}

function sectionHasRelay(section, hosts) {
  const body = section.lines.join("\n")
  return hosts.some((host) => body.includes(host)) || /api_key\s*=\s*"sk-/.test(body) || /experimental_bearer_token\s*=\s*"sk-/.test(body)
}

export function resetCodex(text) {
  const raw = String(text ?? "")
  const onAsteria = /model_provider\s*=\s*"asteria"/.test(raw) || /^\[model_providers\.asteria\]/m.test(raw)
  const marked = raw.startsWith("# asteria_dock")
  const hasCompanyKey = /(?:experimental_bearer_token|api_key)\s*=\s*"sk-/.test(raw)
  if (!onAsteria && !marked && !hasCompanyKey) return raw.endsWith("\n") || raw.length === 0 ? raw : `${raw}\n`
  const prev = dockMarker(raw) ?? {}
  const sections = tomlSections(raw).filter((section) => section.name !== "model_providers.asteria")
  const head = sections[0]
  const set = (key, value) => {
    if (value == null) return
    const pattern = new RegExp(`^${key}\\s*=.*$`, "m")
    const line = `${key} = ${JSON.stringify(value)}`
    const body = head.lines.join("\n")
    head.lines = (pattern.test(body) ? body.replace(pattern, line) : `${body}\n${line}`).split("\n")
  }
  if (head.lines.join("\n").includes('model_provider = "asteria"') && prev.model_provider == null) {
    throw new Error("Codex 没有 Dock 记下的官方配置，不能重置")
  }
  set("model_provider", prev.model_provider)
  set("model", prev.model)
  set("service_tier", prev.service_tier)
  return joinSections(sections)
}

function deleteTomlKey(section, key) {
  section.lines = section.lines.filter((line) => !new RegExp(`^${key}\\s*=`).test(line.trim()))
}

function setTomlKey(section, key, value) {
  const line = `${key} = ${JSON.stringify(value)}`
  const index = section.lines.findIndex((item) => new RegExp(`^${key}\\s*=`).test(item.trim()))
  if (index >= 0) section.lines[index] = line
  else section.lines.push(line)
}

export function resetGrok(text, hosts = []) {
  const prev = dockMarker(text) ?? {}
  const sections = tomlSections(text).filter((section) => {
    if (section.name.startsWith("model.") || section.name.startsWith('model."')) return !sectionHasRelay(section, hosts)
    if (section.name === "models.extra_headers") return false
    return true
  })
  const find = (name) => sections.find((section) => section.name === name)
  const models = find("models")
  if (models) {
    if (prev["models.default"]) setTomlKey(models, "default", prev["models.default"])
    else deleteTomlKey(models, "default")
    for (const key of ["session_summary", "web_search", "allowed_models"]) deleteTomlKey(models, key)
  }
  const endpoints = find("endpoints")
  if (endpoints) deleteTomlKey(endpoints, "models_base_url")
  const auth = find("auth")
  if (auth) deleteTomlKey(auth, "preferred_method")
  const body = joinSections(sections)
  if (hosts.some((host) => body.includes(host)) || /sk-[A-Za-z0-9_-]{8,}/.test(body)) {
    throw new Error("Grok 配置里还有 Asteria 的地址或 key，重置不完整")
  }
  return body
}

export function resetClaude(text, hosts = []) {
  if (!text?.trim()) return text ?? ""
  const data = JSON.parse(text)
  const env = data.env
  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string" && (hosts.some((host) => value.includes(host)) || value.startsWith("sk-"))) delete env[key]
    }
  }
  delete data.asteria_dock
  return `${JSON.stringify(data, null, 2)}\n`
}

export function resetHermes(text, hosts = []) {
  if (!text?.trim() || !hasRelay(text, hosts)) return text ?? ""
  const kept = text.split(/\r?\n/).filter((line) => !hosts.some((host) => line.includes(host)) && !/sk-[A-Za-z0-9_-]{8,}/.test(line) && !line.startsWith("# asteria_dock"))
  return `${kept.join("\n").trimEnd()}\n`
}
