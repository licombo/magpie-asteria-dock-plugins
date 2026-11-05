import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { chooseKey, relayOrigin } from "../lib/keys.mjs"
import { DockPlugin } from "../index.mjs"
import { cleanMessage, cleanUsingDock, login, stripCompanyMarkers } from "../lib/login.mjs"
import { modelRecord } from "../lib/models.mjs"
import { dockTargets, groupUses } from "../lib/targets.mjs"
import { paths } from "../lib/paths.mjs"
import { resetClaude, resetCodex, resetDockConfig, resetHermes, resetOpenCode, resetPi } from "../lib/reset.mjs"

const KEY_A = "sk-test-key-a-0123456789abcdef"
const KEY_B = "sk-test-key-b-fedcba9876543210"

test("company_pins key is removed, company api_key stays", () => {
  const next = resetDockConfig({
    current: { opencode: "company:opencode", grok: "company:grok", agy: null },
    company_pins: { opencode: {}, grok: { selected_model: "grok-4.7" }, agy: { selected_model: "keep" } },
    providers: [{ id: "company:opencode", kind: "company", api_key: KEY_A, status: "supported" }],
  }, ["opencode"])
  assert.equal(next.current.opencode, null)
  assert.equal(next.current.grok, "company:grok")
  assert.equal(Object.hasOwn(next.company_pins, "opencode"), false)
  assert.equal(next.company_pins.grok.selected_model, "grok-4.7")
  assert.equal(next.company_pins.agy.selected_model, "keep")
  assert.equal(next.current.agy, null)
  assert.equal(next.providers[0].api_key, KEY_A)
})

test("opencode asteria provider is removed and an official file stays official", () => {
  const reset = resetOpenCode(JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "asteria/deepseek-flash",
    asteria_dock: { provider_id: "company:opencode" },
    providers: { asteria: { settings: { apiKey: KEY_A, baseURL: "http://relay.example/v1" } }, other: { name: "keep" } },
  }))
  const data = JSON.parse(reset)
  assert.equal(data.model, undefined)
  assert.equal(data.providers.asteria, undefined)
  assert.equal(data.providers.other.name, "keep")
  assert.equal(JSON.parse(resetOpenCode('{\n  "$schema": "https://opencode.ai/config.json"\n}\n')).$schema, "https://opencode.ai/config.json")
})

test("pi and codex restore the previous official provider", () => {
  const pi = resetPi(
    JSON.stringify({ defaultProvider: "asteria", defaultModel: "asteria/gpt-6-luna" }),
    JSON.stringify({ asteria_dock: { prev: { "settings.defaultProvider": "magpie", "settings.defaultModel": "sub2api/grok-4.7" } }, providers: { asteria: { apiKey: KEY_A }, magpie: { apiKey: "magpie" } } }),
  )
  assert.equal(JSON.parse(pi.settings).defaultProvider, "magpie")
  assert.equal(JSON.parse(pi.models).providers.asteria, undefined)
  const codex = resetCodex(`# asteria_dock provider=company:codex prev={"model_provider":"custom","model":"gpt-5.5","service_tier":"fast"}
model_provider = "asteria"
service_tier = "default"

[model_providers.custom]
name = "custom"

[model_providers.asteria]
experimental_bearer_token = "${KEY_A}"
base_url = "http://relay.example/v1"
`)
  assert.match(codex, /model_provider = "custom"/)
  assert.match(codex, /service_tier = "fast"/)
  assert.doesNotMatch(codex, /model_providers\.asteria/)
  assert.doesNotMatch(codex, /sk-test/)
  const official = `model_provider = "custom"\nmodel = "gpt-5.5"\n\n[model_providers.custom]\nbase_url = "http://relay.example/v1"\nrequires_openai_auth = true\n`
  assert.equal(resetCodex(official), official)
  const onCompanyHost = resetCodex(official, ["relay.example"])
  assert.match(onCompanyHost, /model_provider = "magpie"/)
  assert.doesNotMatch(onCompanyHost, /relay\.example/)
})

test("claude keeps the magpie token and hermes drops the relay key", () => {
  const claude = JSON.parse(resetClaude(JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: "magpie",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3425",
      ANTHROPIC_API_KEY: KEY_A,
    },
  }), ["relay.example"]))
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, "magpie")
  assert.equal(claude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3425")
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined)
  const hermes = resetHermes(`model: keep\nbase_url: http://relay.example/v1\napi_key: ${KEY_A}\n`, ["relay.example"])
  assert.match(hermes, /model: keep/)
  assert.doesNotMatch(hermes, /relay\.example|sk-test/)
  assert.equal(resetHermes("model: official\n"), "model: official\n")
})

test("chooseKey keeps the key with more models", async () => {
  const chosen = await chooseKey([
    { key: KEY_A, tool: "claude", updatedAt: "2026-11-04T01:00:00Z" },
    { key: KEY_A, tool: "pi", updatedAt: "2026-11-04T02:00:00Z" },
    { key: KEY_B, tool: "grok", updatedAt: "2026-11-04T03:00:00Z" },
  ].map((entry) => ({ ...entry, origin: "http://relay.example" })), async (url) => ({
    ok: true,
    async json() {
      return { data: url.includes("missing") ? [] : String(url).includes("nope") ? [] : [{ id: "a" }, { id: "b" }] }
    },
  }))
  // fetch ignores the key, so both look equal; newer updatedAt wins on a tie.
  assert.equal(chosen.key, KEY_B)
  const counted = await chooseKey([
    { key: KEY_A, tool: "claude", updatedAt: "2026-11-04T01:00:00Z" },
    { key: KEY_B, tool: "grok", updatedAt: "2026-11-04T03:00:00Z" },
  ].map((entry) => ({ ...entry, origin: "http://relay.example" })), async (_url, init) => ({
    ok: true,
    async json() {
      const key = init.headers.authorization
      return { data: key.endsWith(KEY_A) ? [{ id: "a" }, { id: "b" }, { id: "c" }] : [{ id: "only" }] }
    },
  }))
  assert.equal(counted.key, KEY_A)
  assert.deepEqual(counted.models, ["a", "b", "c"])
})

test("login does not quit Dock when no connected agent uses this provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "dock-login-"))
  const layout = paths(home, "darwin")
  const appliedFile = join(home, "applied.json")
  mkdirSync(layout.dockHome, { recursive: true })
  const before = JSON.stringify({
    current: { opencode: "company:opencode" },
    company_pins: { opencode: {} },
    providers: [{ id: "company:opencode", kind: "company", tool_id: "opencode", status: "supported", api_key: KEY_A, base_url: "http://relay.example/v1" }],
  })
  writeFileSync(layout.dockConfig, before)
  writeFileSync(appliedFile, JSON.stringify({ claude: { fields: { model: "group/coding-models" } } }))
  mkdirSync(dirname(layout.opencode), { recursive: true })
  writeFileSync(layout.opencode, JSON.stringify({ providers: { asteria: { settings: { apiKey: KEY_A } } } }))
  const result = await login({
    paths: layout,
    appliedFile,
    groups: {},
    fetchImpl: async () => ({ ok: true, async json() { return { data: [{ id: "m1" }] } } }),
    control: { quit: async () => { throw new Error("登录不该退出 Dock") }, launch: async () => { throw new Error("登录不该打开 Dock") } },
  })
  assert.equal(result.key, KEY_A)
  assert.deepEqual(result.cleaned, [])
  assert.match(result.instructions, /已保存 key/)
  assert.equal(readFileSync(layout.dockConfig, "utf8"), before)
  assert.equal(existsSync(layout.stamp), false)
})

test("login writes the stamp only after cleanup is confirmed", async () => {
  const home = mkdtempSync(join(tmpdir(), "dock-login-ok-"))
  const layout = paths(home, "darwin")
  mkdirSync(layout.dockHome, { recursive: true })
  writeFileSync(layout.dockConfig, JSON.stringify({
    current: { pi: "company:pi", claude: null, hermes: null },
    company_pins: { pi: {} },
    providers: [{ id: "company:pi", kind: "company", tool_id: "pi", status: "supported", api_key: KEY_A, base_url: "http://relay.example", updated_at: "2026-11-04T00:00:00Z" }],
  }))
  mkdirSync(join(home, ".pi", "agent"), { recursive: true })
  writeFileSync(layout.piSettings, JSON.stringify({ defaultProvider: "asteria", defaultModel: "asteria/x" }))
  writeFileSync(layout.piModels, JSON.stringify({ asteria_dock: { prev: { "settings.defaultProvider": "magpie", "settings.defaultModel": "m" } }, providers: { asteria: { apiKey: KEY_A } } }))
  const result = await login({
    paths: layout,
    applied: {},
    fetchImpl: async () => ({ ok: true, async json() { return { data: [{ id: "m1" }, { id: "m2" }] } } }),
    control: { quit: async () => {}, launch: async () => {} },
    confirm: async () => {},
  })
  assert.equal(result.key, KEY_A)
  const saved = JSON.parse(readFileSync(layout.dockConfig, "utf8"))
  assert.equal(saved.current.pi, "company:pi")
  assert.equal(Object.hasOwn(saved.company_pins, "pi"), true)
  assert.equal(saved.providers[0].api_key, KEY_A)
  assert.equal(existsSync(layout.stamp), false)
  const again = await login({
    paths: layout,
    applied: {},
    fetchImpl: async () => ({ ok: true, async json() { return { data: [{ id: "m1" }] } } }),
    control: { quit: async () => { throw new Error("第二次不该退出 Dock") }, launch: async () => {} },
  })
  assert.equal(again.key, KEY_A)
})

function companyConfig(key = KEY_A) {
  return JSON.stringify({
    current: { opencode: "company:opencode" },
    company_pins: { opencode: {} },
    providers: [{ id: "company:opencode", kind: "company", tool_id: "opencode", status: "supported", api_key: key, base_url: "http://relay.example/v1", updated_at: "2026-11-04T00:00:00Z" }],
  })
}

test("login leaves tool files and the company key where they are", async () => {
  const home = mkdtempSync(join(tmpdir(), "dock-login-files-"))
  const layout = paths(home, "darwin")
  mkdirSync(layout.dockHome, { recursive: true })
  mkdirSync(dirname(layout.claude), { recursive: true })
  writeFileSync(layout.dockConfig, companyConfig())
  const claude = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "magpie", ANTHROPIC_BASE_URL: "http://127.0.0.1:3425" } })
  writeFileSync(layout.claude, claude)
  const result = await login({
    paths: layout,
    applied: {},
    fetchImpl: async () => ({ ok: true, async json() { return { data: [{ id: "m1" }] } } }),
    control: { quit: async () => { throw new Error("登录不该退出 Dock") }, launch: async () => {} },
  })
  assert.equal(result.key, KEY_A)
  assert.equal(readFileSync(layout.claude, "utf8"), claude)
  assert.equal(JSON.parse(readFileSync(layout.dockConfig, "utf8")).providers[0].api_key, KEY_A)
  assert.equal(existsSync(layout.stamp), false)
})

test("windows dock home prefers an existing config and does not leave the given home", () => {
  const home = mkdtempSync(join(tmpdir(), "dock-win-"))
  const fallback = paths(home, "win32", {})
  assert.equal(fallback.dockConfig, join(home, "AppData", "Local", "AsteriaDock", "config.json"))
  const alt = join(home, ".asteria-dock")
  mkdirSync(alt, { recursive: true })
  writeFileSync(join(alt, "config.json"), "{}")
  const found = paths(home, "win32", { LOCALAPPDATA: "/other/AppData/Local" })
  assert.equal(found.dockConfig, join(alt, "config.json"))
})

test("relay origin comes from the issued base url and drops a protocol suffix", () => {
  assert.equal(relayOrigin("http://relay.example/v1"), "http://relay.example")
  assert.equal(relayOrigin("http://relay.example/antigravity"), "http://relay.example/antigravity")
  assert.equal(relayOrigin("not a url"), "")
})

test("manual clean only resets Dock tools whose applied model uses this provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "dock-clean-"))
  const layout = paths(home, "darwin")
  const appliedFile = join(home, "applied.json")
  mkdirSync(layout.dockHome, { recursive: true })
  mkdirSync(dirname(layout.piSettings), { recursive: true })
  writeFileSync(layout.dockConfig, JSON.stringify({
    current: { claude: "company:claude", pi: "company:pi", grok: "company:grok" },
    company_pins: { claude: {}, pi: {}, grok: { selected_model: "grok-4.7" } },
    providers: [{ id: "company:claude", kind: "company", tool_id: "claude", status: "supported", api_key: KEY_A, base_url: "http://relay.example/v1" }],
  }))
  const claudeFile = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "magpie", ANTHROPIC_BASE_URL: "http://127.0.0.1:3425" } })
  mkdirSync(dirname(layout.claude), { recursive: true })
  writeFileSync(layout.claude, claudeFile)
  writeFileSync(layout.piSettings, JSON.stringify({ defaultProvider: "magpie", apiKey: "magpie" }))
  writeFileSync(appliedFile, JSON.stringify({
    claude: { fields: { model: "dock/claude-opus" } },
    pi: { fields: { model: "other/pi" } },
    grok: { fields: { model: "group/coding-models" } },
  }))
  const result = await cleanUsingDock({
    paths: layout,
    appliedFile,
    control: { quit: async () => {}, launch: async () => {} },
    confirm: async () => {},
  })
  assert.deepEqual(result.cleaned, ["claude"])
  const saved = JSON.parse(readFileSync(layout.dockConfig, "utf8"))
  assert.equal(saved.current.claude, null)
  assert.equal(saved.current.pi, "company:pi")
  assert.equal(saved.current.grok, "company:grok")
  assert.equal(Object.hasOwn(saved.company_pins, "claude"), false)
  assert.equal(Object.hasOwn(saved.company_pins, "grok"), true)
  assert.equal(JSON.parse(readFileSync(layout.piSettings, "utf8")).apiKey, "magpie")
  assert.equal(readFileSync(layout.claude, "utf8"), claudeFile)
  assert.equal(saved.providers[0].api_key, KEY_A)
})

test("grok is outside the cleanup even when its applied model uses this provider", () => {
  assert.deepEqual(dockTargets({
    grok: { fields: { model: "dock/grok-4.7" } },
    claude: { fields: { model: "group/coding-models" } },
  }, "dock", {}), [])
})

test("dock target matches direct models and groups that contain this provider", () => {
  const groups = {
    "coding-models": { disabled: true, members: ["group/coding-default"] },
    "coding-default": { members: ["dock/deepseek-flash:high", "dock/glm-5.3:high"] },
    "smart-split": { members: ["group/coding-models", "group/easy-models"] },
    "easy-models": { members: ["other/kimi-k3"] },
    other: { members: ["sub2api/gpt"] },
  }
  assert.equal(groupUses("coding-models", "dock", groups), false)
  assert.equal(groupUses("smart-split", "dock", groups), false)
  groups["coding-models"].disabled = false
  groups["coding-models"].off = ["group/codeing-trae-cli"]
  assert.equal(groupUses("smart-split", "dock", groups), true)
  assert.deepEqual(dockTargets({
    claude: { fields: { opus: "group/coding-models[1m]", model: "group/smart-split[1m]" } },
    pi: { fields: { model: "magpie/dock/deepseek-flash" } },
    codex: { fields: { model: "dock" } },
    hermes: { fields: { model: "group/other" } },
    grok: { fields: { model: "group/coding-default" } },
  }, "dock", groups), ["claude", "pi", "codex"])
})

test("login clears Dock only for connected agents using this provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "dock-login-clean-"))
  const layout = paths(home, "darwin")
  const appliedFile = join(home, "applied.json")
  mkdirSync(layout.dockHome, { recursive: true })
  mkdirSync(dirname(layout.claude), { recursive: true })
  writeFileSync(layout.dockConfig, JSON.stringify({
    current: { claude: "company:claude", pi: "company:pi" },
    company_pins: { claude: {}, pi: {} },
    providers: [
      { id: "company:claude", kind: "company", tool_id: "claude", status: "supported", api_key: KEY_A, base_url: "http://relay.example/v1" },
      { id: "company:pi", kind: "company", tool_id: "pi", status: "supported", api_key: KEY_A, base_url: "http://relay.example/v1" },
    ],
  }))
  const claudeFile = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "magpie" } })
  writeFileSync(layout.claude, claudeFile)
  writeFileSync(appliedFile, JSON.stringify({
    claude: { fields: { model: "dock/claude-opus" } },
    pi: { fields: { model: "other/pi" } },
  }))
  const result = await login({
    paths: layout,
    appliedFile,
    fetchImpl: async () => ({ ok: true, async json() { return { data: [{ id: "m1" }] } } }),
    control: { quit: async () => {}, launch: async () => {} },
    confirm: async () => {},
  })
  assert.equal(result.key, KEY_A)
  assert.deepEqual(result.cleaned, ["claude"])
  assert.match(result.instructions, /已保存 key/)
  assert.match(result.instructions, /claude/)
  const saved = JSON.parse(readFileSync(layout.dockConfig, "utf8"))
  assert.equal(saved.current.claude, null)
  assert.equal(saved.current.pi, "company:pi")
  assert.equal(readFileSync(layout.claude, "utf8"), claudeFile)
  assert.equal(saved.providers[0].api_key, KEY_A)
})

test("a later login does not clear Dock when a tool is back on Asteria", async () => {
  const home = mkdtempSync(join(tmpdir(), "dock-login-drift-"))
  const layout = paths(home, "darwin")
  mkdirSync(layout.dockHome, { recursive: true })
  mkdirSync(dirname(layout.stamp), { recursive: true })
  writeFileSync(layout.stamp, JSON.stringify({ version: 1 }) + "\n")
  writeFileSync(layout.dockConfig, JSON.stringify({
    current: { grok: "company:grok" },
    company_pins: { grok: {} },
    providers: [{ id: "company:grok", kind: "company", tool_id: "grok", status: "supported", api_key: KEY_A, base_url: "http://relay.example/v1" }],
  }))
  const result = await login({
    paths: layout,
    applied: {},
    fetchImpl: async () => ({ ok: true, async json() { return { data: [{ id: "m1" }] } } }),
    control: { quit: async () => { throw new Error("登录不该退出 Dock") }, launch: async () => {} },
  })
  assert.equal(result.key, KEY_A)
  assert.match(result.instructions, /未修改 Dock/)
  const saved = JSON.parse(readFileSync(layout.dockConfig, "utf8"))
  assert.equal(saved.current.grok, "company:grok")
  assert.equal(Object.hasOwn(saved.company_pins, "grok"), true)
  assert.equal(saved.providers[0].api_key, KEY_A)
})

test("manual clean writes a Dock-changed tool file back so the magpie key stays", async () => {
  const home = mkdtempSync(join(tmpdir(), "dock-clean-restore-"))
  const layout = paths(home, "darwin")
  const appliedFile = join(home, "applied.json")
  mkdirSync(layout.dockHome, { recursive: true })
  mkdirSync(dirname(layout.claude), { recursive: true })
  writeFileSync(layout.dockConfig, JSON.stringify({
    current: { claude: "company:claude" },
    company_pins: { claude: {} },
    providers: [{ id: "company:claude", kind: "company", tool_id: "claude", status: "supported", api_key: KEY_A, base_url: "http://relay.example/v1" }],
  }))
  const claudeFile = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "magpie" } })
  writeFileSync(layout.claude, claudeFile)
  writeFileSync(appliedFile, JSON.stringify({ claude: { fields: { model: "dock/claude-opus" } } }))
  const result = await cleanUsingDock({
    paths: layout,
    appliedFile,
    control: { quit: async () => {}, launch: async () => {} },
    confirm: async () => {
      writeFileSync(layout.claude, JSON.stringify({ env: { ANTHROPIC_API_KEY: KEY_A } }))
    },
  })
  assert.deepEqual(result.cleaned, ["claude"])
  assert.equal(result.restored, true)
  assert.equal(readFileSync(layout.claude, "utf8"), claudeFile)
  assert.match(cleanMessage(result), /写回/)
  assert.match(cleanMessage(result), /key 没有换/)
})

test("cleanup strips company markers for every selected agent and keeps magpie keys", () => {
  const home = mkdtempSync(join(tmpdir(), "dock-strip-agents-"))
  const layout = paths(home, "darwin")
  mkdirSync(dirname(layout.piModels), { recursive: true })
  mkdirSync(dirname(layout.opencode), { recursive: true })
  mkdirSync(dirname(layout.codex), { recursive: true })
  mkdirSync(dirname(layout.claude), { recursive: true })
  mkdirSync(dirname(layout.hermes), { recursive: true })
  writeFileSync(layout.piSettings, JSON.stringify({ defaultProvider: "magpie", defaultModel: "group/smart-split" }))
  writeFileSync(layout.piModels, JSON.stringify({
    providers: { magpie: { apiKey: "magpie", baseUrl: "http://127.0.0.1:3425/v1" } },
  }))
  writeFileSync(`${layout.piModels}.asteria.bak`, "ASTERIA_CREATED\n")
  writeFileSync(layout.opencode, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "asteria/deepseek-flash",
    asteria_dock: { provider_id: "company:opencode" },
    provider: {
      asteria: { options: { apiKey: KEY_A, baseURL: "http://relay.example/v1" } },
      magpie: { options: { apiKey: "magpie", baseURL: "http://127.0.0.1:3425/v1" } },
    },
  }))
  writeFileSync(`${layout.opencode}.asteria.bak`, "{}\n")
  writeFileSync(layout.codex, `model_provider = "custom"\nmodel = "gpt-5.5"\n\n[model_providers.custom]\nbase_url = "http://relay.example/v1"\nrequires_openai_auth = true\n\n[model_providers.magpie]\nbase_url = "http://127.0.0.1:3425/v1"\nexperimental_bearer_token = "magpie"\n`)
  writeFileSync(`${layout.codex}.asteria.bak`, "model_provider = \"custom\"\n")
  writeFileSync(layout.claude, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: "magpie",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3425",
      ANTHROPIC_API_KEY: KEY_A,
    },
  }))
  writeFileSync(`${layout.claude}.asteria.bak`, "{}\n")
  writeFileSync(layout.hermes, `model: keep\nbase_url: http://relay.example/v1\napi_key: ${KEY_A}\n`)
  writeFileSync(`${layout.hermes}.asteria.bak`, "model: old\n")

  const changed = stripCompanyMarkers(layout, ["pi", "opencode", "codex", "claude", "hermes"], ["relay.example"])
  assert.deepEqual(changed.sort(), ["claude", "codex", "hermes", "opencode", "pi"])

  const pi = JSON.parse(readFileSync(layout.piModels, "utf8"))
  assert.equal(pi.providers.magpie.apiKey, "magpie")
  assert.equal(existsSync(`${layout.piModels}.asteria.bak`), false)
  const opencode = JSON.parse(readFileSync(layout.opencode, "utf8"))
  assert.equal(opencode.provider.asteria, undefined)
  assert.equal(opencode.asteria_dock, undefined)
  assert.equal(opencode.model, undefined)
  assert.equal(opencode.provider.magpie.options.apiKey, "magpie")
  assert.equal(existsSync(`${layout.opencode}.asteria.bak`), false)
  const codex = readFileSync(layout.codex, "utf8")
  assert.match(codex, /model_provider = "magpie"/)
  assert.match(codex, /experimental_bearer_token = "magpie"/)
  assert.doesNotMatch(codex, /relay\.example/)
  assert.equal(existsSync(`${layout.codex}.asteria.bak`), false)
  const claude = JSON.parse(readFileSync(layout.claude, "utf8"))
  assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN, "magpie")
  assert.equal(claude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:3425")
  assert.equal(claude.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(existsSync(`${layout.claude}.asteria.bak`), false)
  const hermes = readFileSync(layout.hermes, "utf8")
  assert.match(hermes, /model: keep/)
  assert.doesNotMatch(hermes, /relay\.example|sk-test/)
  assert.equal(existsSync(`${layout.hermes}.asteria.bak`), false)
})

test("cleanup strips Pi's company marker and keeps the magpie provider", () => {
  const home = mkdtempSync(join(tmpdir(), "dock-strip-pi-"))
  const layout = paths(home, "darwin")
  mkdirSync(dirname(layout.piModels), { recursive: true })
  writeFileSync(layout.piSettings, JSON.stringify({ defaultProvider: "magpie", defaultModel: "group/smart-split" }))
  writeFileSync(layout.piModels, JSON.stringify({
    asteria_dock: { provider_id: "company:pi", prev: { "settings.defaultProvider": "magpie" } },
    providers: {
      magpie: { apiKey: "magpie", baseUrl: "http://127.0.0.1:3425/v1" },
      asteria: { apiKey: KEY_A, baseUrl: "http://relay.example/v1" },
    },
  }))
  assert.deepEqual(stripCompanyMarkers(layout, ["pi"], ["relay.example"]), ["pi"])
  const models = JSON.parse(readFileSync(layout.piModels, "utf8"))
  assert.equal(models.asteria_dock, undefined)
  assert.equal(models.providers.asteria, undefined)
  assert.equal(models.providers.magpie.apiKey, "magpie")
  assert.equal(JSON.parse(readFileSync(layout.piSettings, "utf8")).defaultProvider, "magpie")
})

test("trae models Magpie does not know are given a 1M window", () => {
  for (const id of ["deepseek-flash-trae", "glm-5.3-trae", "glm-5.3-flashx-trae"]) {
    assert.equal(modelRecord(id, "http://relay.example", "dock", "@ai-sdk/openai-compatible").limit.context, 1_000_000)
  }
  assert.equal(modelRecord("glm-5.3", "http://relay.example", "dock").limit, undefined)
})

test("login is the only sign-in method", () => {
  const plugin = DockPlugin()
  assert.equal(plugin.auth.methods.length, 1)
  assert.equal(plugin.auth.methods[0].label, "Asteria Dock")
})

test("login returns the origin issued with the chosen key", async () => {
  const home = mkdtempSync(join(tmpdir(), "dock-login-origin-"))
  const layout = paths(home, "darwin")
  mkdirSync(layout.dockHome, { recursive: true })
  mkdirSync(dirname(layout.stamp), { recursive: true })
  writeFileSync(layout.stamp, "{}\n")
  writeFileSync(layout.dockConfig, JSON.stringify({
    providers: [
      { id: "company:pi", kind: "company", tool_id: "pi", status: "supported", api_key: KEY_A, base_url: "http://relay-a.example/v1" },
      { id: "company:grok", kind: "company", tool_id: "grok", status: "supported", api_key: KEY_B, base_url: "http://relay-b.example/v1" },
    ],
  }))
  const seen = []
  const result = await login({
    paths: layout,
    applied: {},
    fetchImpl: async (url) => {
      seen.push(url)
      return { ok: true, async json() { return { data: String(url).includes("relay-a") ? [{ id: "a" }, { id: "b" }] : [{ id: "only" }] } } }
    },
    control: { quit: async () => { throw new Error("已有重置记录") }, launch: async () => {} },
  })
  assert.equal(result.key, KEY_A)
  assert.equal(result.origin, "http://relay-a.example")
  assert.deepEqual(seen, ["http://relay-a.example/v1/models", "http://relay-b.example/v1/models"])
})
