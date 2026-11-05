import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const TOOLS = ["claude", "pi", "opencode", "codex", "hermes"]

function dockCandidates(home, platform, env) {
  if (platform !== "win32") return [join(home, ".asteria-dock")]
  const candidates = [join(home, "AppData", "Local", "AsteriaDock"), join(home, ".asteria-dock")]
  if (env.LOCALAPPDATA && (env.LOCALAPPDATA === home || env.LOCALAPPDATA.startsWith(`${home}\\`) || env.LOCALAPPDATA.startsWith(`${home}/`))) {
    candidates.unshift(join(env.LOCALAPPDATA, "AsteriaDock"))
  }
  return [...new Set(candidates)]
}

export function paths(home = homedir(), platform = process.platform, env = process.env) {
  const candidates = dockCandidates(home, platform, env)
  const dockHome = candidates.find((dir) => existsSync(join(dir, "config.json"))) ?? candidates[0]
  return {
    home,
    platform,
    dockHome,
    dockConfig: join(dockHome, "config.json"),
    session: join(dockHome, "session.json"),
    stamp: join(home, ".config", "magpie", "dock-reset.json"),
    log: platform === "win32"
      ? join(dockHome, "Asteria Dock.log")
      : join(home, "Library", "Logs", "com.asteria.dock", "Asteria Dock.log"),
    piSettings: join(home, ".pi", "agent", "settings.json"),
    piModels: join(home, ".pi", "agent", "models.json"),
    opencode: join(home, ".config", "opencode", "opencode.json"),
    opencodeJsonc: join(home, ".config", "opencode", "opencode.jsonc"),
    codex: join(home, ".codex", "config.toml"),
    claude: join(home, ".claude", "settings.json"),
    hermes: join(home, ".hermes", "config.yaml"),
  }
}
