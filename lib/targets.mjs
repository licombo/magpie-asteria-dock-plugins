import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { TOOLS } from "./paths.mjs"

export function usesDock(model, providerId = "dock") {
  const value = String(model ?? "")
  if (!value || value.startsWith("group/")) return false
  return value === providerId || value.startsWith(`${providerId}/`) || value.startsWith(`${providerId}-`)
}

export function dockTargets(applied, providerId = "dock") {
  const found = []
  for (const [tool, record] of Object.entries(applied ?? {})) {
    if (!TOOLS.includes(tool) || !record || typeof record !== "object") continue
    const fields = record.fields ?? {}
    const models = Object.values(fields).filter((value) => typeof value === "string")
    if (models.some((model) => usesDock(model, providerId))) found.push(tool)
  }
  return found
}

export function readApplied(file = join(homedir(), ".config", "magpie", "applied.json")) {
  if (!existsSync(file)) return {}
  const data = JSON.parse(readFileSync(file, "utf8"))
  return data && typeof data === "object" ? data : {}
}
