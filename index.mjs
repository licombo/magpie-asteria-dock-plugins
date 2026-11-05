import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { companyKeys, listModelIds, relayOrigin } from "./lib/keys.mjs"
import { modelRecord } from "./lib/models.mjs"
import { login, stillCompany } from "./lib/login.mjs"
import { paths } from "./lib/paths.mjs"
import { dockTargets, readApplied, readGroups } from "./lib/targets.mjs"

const ID = "dock"
const CHAT = "@ai-sdk/openai-compatible"
const MESSAGES = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"

const icon = `data:image/png;base64,${readFileSync(join(dirname(fileURLToPath(import.meta.url)), "icon.png")).toString("base64")}`

function dockConflict() {
  const file = paths().dockConfig
  if (!existsSync(file)) return []
  const targets = new Set(dockTargets(readApplied(), "dock", readGroups()))
  return stillCompany(JSON.parse(readFileSync(file, "utf8"))).filter((tool) => targets.has(tool))
}

function npmFor(id) {
  if (/claude/i.test(id)) return MESSAGES
  if (/(?:^|\/)(?:gpt-|o\d|codex-)/i.test(id)) return RESPONSES
  return CHAT
}

function savedKey(auth) {
  if (!auth || typeof auth !== "object") return ""
  const key = auth.key || auth.access || ""
  return typeof key === "string" && key.startsWith("sk-") ? key : ""
}

function savedOrigin(auth) {
  const origin = relayOrigin(auth?.origin || auth?.baseURL || "")
  if (origin) return origin
  if (!existsSync(paths().dockConfig)) return ""
  const config = JSON.parse(readFileSync(paths().dockConfig, "utf8"))
  const key = savedKey(auth)
  return companyKeys(config).find((entry) => entry.key === key)?.origin ?? ""
}

export function DockPlugin() {
  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[ID] ?? {}
      cfg.provider[ID] = {
        name: "Asteria Dock",
        npm: CHAT,
        ...was,
        models: was.models ?? {},
      }
    },

    auth: {
      provider: ID,
      icon,
      async loader(getAuth) {
        const auth = await getAuth()
        const key = savedKey(auth)
        const origin = savedOrigin(auth)
        if (!key || !origin) return {}
        return { baseURL: `${origin}/v1`, apiKey: key }
      },
      methods: [
        {
          type: "oauth",
          label: "Asteria Dock",
          authorize: async () => {
            const result = await login()
            return {
              url: "",
              instructions: result.instructions,
              method: "auto",
              callback: async () => ({
                type: "success",
                refresh: "asteria-dock",
                access: result.key,
                key: result.key,
                origin: result.origin,
                expires: 0,
                accountId: result.accountId,
              }),
            }
          },
        },
      ],
      async usage() {
        const conflict = dockConflict()
        if (conflict.length) {
          return { error: `Dock 里 ${conflict.join("、")} 仍是公司配置。再登录一次这个供应商就会清这些已接入且模型属于这家供应商的 agent。不会改工具文件里的 Magpie key。`, windows: [] }
        }
        return { windows: [] }
      },
    },

    provider: {
      id: ID,
      async models(_provider, { auth } = {}) {
        const key = savedKey(auth)
        const origin = savedOrigin(auth)
        if (!key || !origin) return {}
        const ids = await listModelIds(origin, key)
        return Object.fromEntries(ids.map((id) => [id, modelRecord(id, origin, ID, npmFor(id))]))
      },
    },
  }
}

export default { id: ID, server: DockPlugin }
