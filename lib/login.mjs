import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs"
import { dirname } from "node:path"
import { spawn } from "node:child_process"
import { TOOLS, paths } from "./paths.mjs"
import { chooseKey, companyKeys } from "./keys.mjs"
import { dockTargets, readApplied, readGroups } from "./targets.mjs"
import { resetDockConfig } from "./reset.mjs"

const VERIFY_MS = 20_000

function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : ""
}

function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const mode = existsSync(file) ? statSync(file).mode : 0o600
  writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, { mode })
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} 退出码 ${code}${stderr ? `: ${stderr.trim()}` : ""}`))
    })
  })
}

async function dockRunning() {
  if (process.platform === "win32") {
    try {
      const stdout = await run("tasklist", ["/FI", "IMAGENAME eq asteria-dock.exe", "/NH"])
      return /asteria-dock\.exe/i.test(stdout)
    } catch {
      return false
    }
  }
  try {
    await run("pgrep", ["-f", "Contents/MacOS/asteria-dock"])
    return true
  } catch {
    return false
  }
}

export function liveControl() {
  return {
    async quit() {
      if (!(await dockRunning())) return
      if (process.platform === "darwin") await run("osascript", ["-e", 'tell application "Asteria Dock" to quit'])
      else await run("taskkill", ["/IM", "asteria-dock.exe", "/T"])
      const deadline = Date.now() + 10_000
      while (await dockRunning()) {
        if (Date.now() > deadline) throw new Error("Asteria Dock 没有退出")
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    },
    async launch() {
      if (process.platform === "darwin") {
        await run("open", ["-a", "Asteria Dock"])
        return
      }
      const candidates = [
        `${process.env.LOCALAPPDATA}\\Programs\\Asteria Dock\\asteria-dock.exe`,
        `${process.env.LOCALAPPDATA}\\AsteriaDock\\asteria-dock.exe`,
      ]
      const exe = candidates.find((file) => file && existsSync(file))
      if (!exe) throw new Error("没有找到 Windows 上的 Asteria Dock，没法重新打开")
      await run("cmd", ["/c", "start", "", exe])
    },
  }
}

function agentFiles(layout) {
  return [layout.opencode, layout.opencodeJsonc, layout.piSettings, layout.piModels, layout.codex, layout.claude, layout.hermes]
}

function snapshotFiles(layout) {
  return new Map(agentFiles(layout).map((file) => [file, existsSync(file) ? readFileSync(file) : null]))
}

function sameBytes(file, bytes) {
  if (bytes == null) return !existsSync(file)
  if (!existsSync(file)) return false
  return readFileSync(file).equals(bytes)
}

function holdsMagpieKey(bytes) {
  if (!bytes) return false
  const text = bytes.toString("utf8")
  return text.includes("magpie") || text.includes("127.0.0.1:3425")
}

function restoreMagpieFiles(snap) {
  let restored = false
  for (const [file, bytes] of snap) {
    if (!holdsMagpieKey(bytes) || sameBytes(file, bytes)) continue
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
    restored = true
  }
  return restored
}

export function stillCompany(config) {
  const current = config.current ?? {}
  const pins = config.company_pins ?? {}
  return TOOLS.filter((tool) => current[tool] || Object.prototype.hasOwnProperty.call(pins, tool))
}

export async function releaseCompany(options = {}) {
  const layout = options.layout ?? options.paths ?? paths()
  const control = options.control ?? liveControl()
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const applied = options.applied ?? readApplied(options.appliedFile)
  const groups = options.groups ?? readGroups(options.groupsFile)
  const tools = (options.tools ?? dockTargets(applied, options.providerId, groups)).filter((tool) => TOOLS.includes(tool))
  if (tools.length === 0) return { tools: [], restored: false }
  const snap = snapshotFiles(layout)
  const logBefore = readText(layout.log).length
  let launched = false
  try {
    await control.quit()
    const fresh = JSON.parse(readText(layout.dockConfig))
    const selected = tools.filter((tool) => stillCompany(fresh).includes(tool))
    if (selected.length === 0) {
      await control.launch()
      launched = true
      await (options.confirm ?? confirmLog)(layout, logBefore, sleep, options.timeoutMs ?? VERIFY_MS, options.pollMs ?? 500)
      const restored = restoreMagpieFiles(snap)
      if ([...snap].some(([file, bytes]) => holdsMagpieKey(bytes) && !sameBytes(file, bytes))) {
        throw new Error("工具文件里的 Magpie key 被改过，写回失败。没有继续。")
      }
      return { tools: [], restored }
    }
    const reset = resetDockConfig(fresh, selected)
    writeText(layout.dockConfig, `${JSON.stringify(reset, null, 2)}\n`)
    await control.launch()
    launched = true
    await (options.confirm ?? confirmLog)(layout, logBefore, sleep, options.timeoutMs ?? VERIFY_MS, options.pollMs ?? 500)
    assertStayedOfficial(layout, selected)
    const restored = restoreMagpieFiles(snap)
    if ([...snap].some(([file, bytes]) => holdsMagpieKey(bytes) && !sameBytes(file, bytes))) {
      throw new Error("工具文件里的 Magpie key 被改过，写回失败。没有继续。")
    }
    writeText(layout.stamp, `${JSON.stringify({ version: 1, at: new Date().toISOString(), tools: selected }, null, 2)}\n`)
    return { tools: selected, restored }
  } catch (error) {
    try { restoreMagpieFiles(snap) } catch { /* 保留原来的失败原因 */ }
    if (!launched) {
      try { await control.launch() } catch { /* 保留原来的失败原因 */ }
    }
    throw error
  }
}

export async function cleanUsingDock(options = {}) {
  const applied = options.applied ?? readApplied(options.appliedFile)
  const groups = options.groups ?? readGroups(options.groupsFile)
  const tools = dockTargets(applied, options.providerId, groups)
  if (tools.length === 0) return { tools: [], cleaned: [], restored: false }
  const released = await releaseCompany({ ...options, applied, tools })
  return { tools, cleaned: released?.tools ?? [], restored: Boolean(released?.restored) }
}

export async function login(options = {}) {
  const layout = options.paths ?? paths()
  const fetchImpl = options.fetchImpl ?? fetch
  if (!existsSync(layout.dockConfig)) throw new Error("没有找到 Asteria Dock 的 config.json")
  const config = JSON.parse(readText(layout.dockConfig))
  const entries = companyKeys(config)
  if (entries.length === 0) throw new Error("Asteria Dock 里还没有可用的 key。先在 Dock 里完成登录。")
  const chosen = await chooseKey(entries, fetchImpl)
  if (!chosen?.key || chosen.models.length === 0) throw new Error("没有拿到带模型列表的 key")

  const applied = options.applied ?? readApplied(options.appliedFile)
  const groups = options.groups ?? readGroups(options.groupsFile)
  const tools = dockTargets(applied, options.providerId, groups)
  const clean = await cleanUsingDock({ ...options, applied, groups, tools })
  return {
    key: chosen.key,
    origin: chosen.origin,
    models: chosen.models,
    accountId: "asteria-dock",
    cleaned: clean.cleaned,
    restored: clean.restored,
    instructions: loginMessage(clean),
  }
}

function loginMessage(result) {
  const kept = result?.restored
    ? "Dock 启动时改过工具文件，已按清理前的内容写回。Magpie 的 key 还在。"
    : "工具文件没有改，Magpie 的 key 还在。"
  if (!result?.tools?.length) return `已保存 key。没有已接入且正在使用这家供应商的 agent，未修改 Dock。${kept}`
  if (!result.cleaned?.length) return `已保存 key。已接入且正在使用：${result.tools.join("、")}。Dock 里这些工具已经是官方配置。${kept}`
  return `已保存 key。已清理 Dock 里的 ${result.cleaned.join("、")}。${kept}`
}

export function cleanMessage(result) {
  const kept = result?.restored
    ? "Dock 启动时改过工具文件，已按清理前的内容写回。Magpie 的 key 还在。"
    : "工具文件没有改，Magpie 的 key 还在。"
  const note = `这一步不是登录。已保存的 key 没有换。${kept}`
  if (!result?.tools?.length) return `没有已接入且正在使用这家供应商的 agent，未修改 Dock。${note}`
  if (!result.cleaned?.length) return `已接入且正在使用：${result.tools.join("、")}。Dock 里这些工具已经是官方配置。${note}`
  return `已清理 Dock 里的 ${result.cleaned.join("、")}。${note}`
}

export async function confirmLog(layout, logBefore, sleep, timeoutMs = VERIFY_MS, pollMs = 500) {
  const started = Date.now()
  let reconcile = ""
  while (true) {
    const matches = [...readText(layout.log).slice(logBefore).matchAll(/reconcile wrote (\d+) live file/g)]
    if (matches.length) reconcile = matches.at(-1)[1]
    if (Date.now() - started >= timeoutMs) break
    await sleep(pollMs)
  }
  if (!reconcile) throw new Error("没有看到 Dock 启动后的 reconcile")
}

export function assertStayedOfficial(layout, tools = TOOLS) {
  const config = JSON.parse(readText(layout.dockConfig))
  const stuck = stillCompany(config).filter((tool) => tools.includes(tool))
  if (stuck.length) throw new Error(`这些工具的 current 或 company_pins 又被写回了：${stuck.join("、")}`)
  for (const provider of config.providers ?? []) {
    if (provider?.kind === "company" && provider.api_key && !String(provider.api_key).startsWith("sk-")) {
      throw new Error(`${provider.id} 的 key 丢了`)
    }
  }
}
