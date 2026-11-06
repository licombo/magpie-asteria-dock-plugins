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
    if (!hasRelay(raw, hosts) && !raw.includes("asteria")) return text
    throw new Error("OpenCode 配置不是 JSON，没法安全清掉 Asteria")
  }
  for (const key of ["providers", "provider"]) {
    const providers = data[key]
    if (!providers || typeof providers !== "object") continue
    delete providers.asteria
    for (const [name, value] of Object.entries(providers)) {
      if (providerUsesHosts(value, hosts)) delete providers[name]
    }
  }
  delete data.asteria_dock
  if (typeof data.model === "string" && data.model.startsWith("asteria/")) delete data.model
  if (typeof data.small_model === "string" && data.small_model.startsWith("asteria/")) delete data.small_model
  const leftover = Object.keys(data).filter((key) => key !== "$schema")
  if (leftover.length === 0) return OPENCODE_OFFICIAL
  return `${JSON.stringify(data, null, 2)}\n`
}

function providerUsesHosts(value, hosts) {
  if (!hosts.length || !value || typeof value !== "object") return false
  const blob = JSON.stringify(value)
  return hosts.some((host) => blob.includes(host)) || /sk-[A-Za-z0-9_-]{8,}/.test(blob)
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

export function resetCodex(text, hosts = []) {
  const raw = String(text ?? "")
  const onAsteria = /model_provider\s*=\s*"asteria"/.test(raw) || /^\[model_providers\.asteria\]/m.test(raw)
  const marked = raw.startsWith("# asteria_dock")
  const hasCompanyKey = /(?:experimental_bearer_token|api_key)\s*=\s*"sk-/.test(raw)
  const onCompanyHost = hosts.length > 0 && codexPointsAtHosts(raw, hosts)
  if (!onAsteria && !marked && !hasCompanyKey && !onCompanyHost) return raw.endsWith("\n") || raw.length === 0 ? raw : `${raw}\n`
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
  if (head.lines.join("\n").includes('model_provider = "asteria"') && prev.model_provider == null && !onCompanyHost) {
    throw new Error("Codex 没有 Dock 记下的官方配置，不能重置")
  }
  set("model_provider", prev.model_provider ?? (onCompanyHost ? "magpie" : undefined))
  set("model", prev.model)
  set("service_tier", prev.service_tier)
  if (onCompanyHost) {
    for (const section of sections) {
      if (section.name === "model_providers.custom" || section.name.startsWith("model_providers.custom.")) {
        clearCompanyToml(section, hosts)
      }
    }
  }
  return joinSections(sections)
}

function codexPointsAtHosts(text, hosts) {
  const selected = /model_provider\s*=\s*"([^"]+)"/.exec(String(text))?.[1]
  if (!selected || selected === "magpie") return false
  const sections = tomlSections(text)
  const block = sections.find((section) => section.name === `model_providers.${selected}`)
  return Boolean(block && hosts.some((host) => block.lines.join("\n").includes(host)))
}

function clearCompanyToml(section, hosts) {
  section.lines = section.lines.filter((line) => !hosts.some((host) => line.includes(host)) && !/(?:experimental_bearer_token|api_key)\s*=\s*"sk-/.test(line))
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
  for (const key of CLAUDE_MODEL_LIMITS) delete data[key]
  return `${JSON.stringify(data, null, 2)}\n`
}

const CLAUDE_MODEL_LIMITS = ["availableModels", "enforceAvailableModels", "deniedModels"]

export function clearClaudeModelLimits(text) {
  if (!text?.trim()) return { text: text ?? "", changed: false }
  const data = JSON.parse(text)
  const changed = CLAUDE_MODEL_LIMITS.some((key) => Object.hasOwn(data, key))
  if (!changed) return { text, changed: false }
  for (const key of CLAUDE_MODEL_LIMITS) delete data[key]
  return { text: `${JSON.stringify(data, null, 2)}\n`, changed: true }
}

export function resetHermes(text, hosts = []) {
  if (!text?.trim() || !hasRelay(text, hosts)) return text ?? ""
  const kept = text.split(/\r?\n/).filter((line) => !hosts.some((host) => line.includes(host)) && !/sk-[A-Za-z0-9_-]{8,}/.test(line) && !line.startsWith("# asteria_dock"))
  return `${kept.join("\n").trimEnd()}\n`
}
