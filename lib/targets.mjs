import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { TOOLS } from "./paths.mjs"

export function usesDock(model, providerId = "dock", groups = {}) {
  const value = modelRef(model)
  if (!value) return false
  if (value.startsWith("group/")) return groupUses(value.slice("group/".length), providerId, groups)
  return value === providerId || value.startsWith(`${providerId}/`) || value.startsWith(`${providerId}-`)
}

function firstModel(fields) {
  if (!fields || typeof fields !== "object") return ""
  if (typeof fields.model === "string") return fields.model
  const value = Object.values(fields).find((item) => typeof item === "string")
  return value ?? ""
}

function modelRef(model) {
  return String(model ?? "").replace(/^(?:magpie\/)+/, "").replace(/\[.*$/, "")
}

function memberProvider(member) {
  const body = String(member ?? "").split(":")[0]
  if (!body || body.startsWith("group/")) return ""
  return body.split("/")[0]
}

export function groupUses(groupId, providerId = "dock", groups = {}, seen = new Set()) {
  if (!groupId || seen.has(groupId)) return false
  const group = groups[groupId]
  if (!group || group.disabled || group.off) return false
  seen = new Set(seen)
  seen.add(groupId)
  for (const member of group.members ?? []) {
    const body = String(member ?? "").split(":")[0]
    if (body.startsWith("group/") && groupUses(body.slice("group/".length), providerId, groups, seen)) return true
    const provider = memberProvider(member)
    if (provider === providerId) return true
  }
  return false
}

export function readGroups(file = join(homedir(), ".config", "magpie", "providers.json")) {
  if (!existsSync(file)) return {}
  const data = JSON.parse(readFileSync(file, "utf8"))
  const groups = {}
  for (const group of data?.groups ?? []) {
    if (!group?.id) continue
    groups[group.id] = { members: group.members ?? [], disabled: Boolean(group.disabled || group.off) }
  }
  return groups
}

export function dockTargets(applied, providerId = "dock", groups = readGroups()) {
  const found = []
  for (const [tool, record] of Object.entries(applied ?? {})) {
    if (!TOOLS.includes(tool) || !record || typeof record !== "object") continue
    const model = firstModel(record.fields)
    if (usesDock(model, providerId, groups)) found.push(tool)
  }
  return found
}

export function readApplied(file = join(homedir(), ".config", "magpie", "applied.json")) {
  if (!existsSync(file)) return {}
  const data = JSON.parse(readFileSync(file, "utf8"))
  return data && typeof data === "object" ? data : {}
}
