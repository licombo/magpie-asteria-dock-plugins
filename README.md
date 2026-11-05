# asteria-dock

Magpie 供应商插件。从已经登录的 Asteria Dock 读取公司 `sk-`，选模型最多的一把，存进 Magpie。供应商 id 是 `dock`，和已安装的 `sub2api` 分开。

登录把公司 `sk-` 存进 Magpie。如果有 agent 已经接入、并且当前模型属于这家供应商，同一次登录会清理这些工具的 Dock 配置。公司供应商记录上的 `sk-` 不删，工具文件里的 Magpie key 不删。

## Dock 的 Asteria 和 Magpie 不能同时开

这是使用这个插件的前提。`claude`、`pi`、`opencode`、`codex`、`hermes` 里，同一个工具不能一边在 Dock 里选 Asteria，一边在 Magpie 里接入。

两边写的是同一份工具配置：

- Dock 选 Asteria 时，写入公司 `sk-` 和 Dock 下发的站点地址。Dock 还在运行时，启动和后续对账会继续维护这份公司配置。
- Magpie 接入时，写入自己的网关 token 和 `http://127.0.0.1:3425`。

同时开着，后写的一边会盖掉另一边。常见结果是 Magpie 里显示已接入，请求仍走 Dock；或者 Dock 重启后把 Magpie 的配置刷回公司配置。

要用 Magpie，Dock 里这些工具必须停在官方配置。要用 Dock 的 Asteria，先在 Magpie 里断开对应 agent。插件不会在每次请求、每次拉模型或每次打开 Magpie 时做这件事。登录时才会按当时的接入情况清理。

`agy`、`dsh`、`grok` 不在这套清理里。Grok 不支持换成别的模型，登录不改它的 Dock 选择，也不改 `~/.grok/config.toml`。

## 安装和登录

Dock 需要先登录。插件弹不出 Dock 的扫码窗，也弹不出公司站点的登录页。

```sh
magpie plugin add /path/to/asteria-dock
magpie plugin login dock
```

登录只有一种。添加账号和重新登录是同一次操作，都会保存 key，并按当时的接入情况清理。

## 登录时清理

清理只在登录时发生。拉模型和读用量不会退出 Dock，也不会改配置。

它只处理同时满足这两条的工具：

1. `~/.config/magpie/applied.json` 里有它，说明 Magpie 已经接入。
2. 它的第一个模型字段走这家供应商。Magpie 供应商行也只看这一个字段。直接选中的名字去掉 `magpie/` 后是 `dock`、`dock/...` 或 `dock-...`。选的是 `group/组id` 时，按 `~/.config/magpie/providers.json` 展开成员，`[1m]` 先去掉。成员是 `dock/模型` 就算；成员又是组就继续展开。组的 `disabled` 为真时整组跳过。`off` 是关掉的成员列表，只跳过列出的成员。别的供应商、只是登录了 Dock，都不算正在使用。

没有命中的工具不动。命中之后，插件退出并重新打开 Dock，只把这些工具的 `current` 置空、删掉对应的 `company_pins`。公司 `providers[]` 里的 `sk-` 留着。

工具文件不改。里面的 Magpie 网关 token 和 `http://127.0.0.1:3425` 留着。如果这次重启把带 Magpie key 的工具文件改掉了，插件按清理前的内容写回去。

没有单独的清理按钮。供应商页的沙箱按钮改不了本机文件，所以清理跟登录走同一次点击。没有命中的工具时，这次登录只保存 key，不退出 Dock。

## Dock 被改回 Asteria 之后

插件不会在拉模型、读用量或转发请求时退出 Dock。拉模型大约每小时一次，用量大约每分钟一次，拿来重启 Dock 会打断正在用的窗口。

账号卡片上的刷新按钮只读用量。Dock 没有额度接口，所以这里仍显示暂无额度。如果已接入且正在使用这家供应商的工具又选回了 Asteria，用量卡片会提示，但不会退出 Dock。

要清回官方，再登录一次这个供应商。它按当时的接入和模型重新判断，不是把上次清过的工具再清一遍。

清完后，到 Magpie 里确认对应 agent 仍是接入状态。插件不会改写 Magpie 已经写入的网关配置。

## 选哪把 key

公司 key 在 `~/.asteria-dock/config.json` 的 `providers[]` 里，`kind` 是 `company`，值以 `sk-` 开头。`session.json` 里的 `sso_token` 不是这把 key。

插件跳过 `disabled`、`expired`、`quota_exhausted`、`unsupported`。同一把 key 只计一次，数量按实时 `GET /v1/models`，不按 Dock 缓存的 `models.length`。数量相同用较新的 `updated_at`。

站点地址用 Dock 下发给这家供应商的 `base_url`。插件里不写地址。`base_url` 带 `/v1` 时，模型请求发到这个 origin 的 `/v1/models`；带别的路径时保留该路径。没有 `base_url` 的记录不参与选 key。

模型按 id 选协议：Claude 用 `@ai-sdk/anthropic`，`gpt-`、`oN`、`codex-` 用 `@ai-sdk/openai`，其余用 `@ai-sdk/openai-compatible`。

## 什么才算 Dock 侧清干净

三个标志要一起成立，缺一个都会在重启后被刷回去：

1. `current.<tool>` 设成 `null`。
2. 删掉 `company_pins.<tool>` 这个键。留一个空对象 `{}` 不够，Dock 仍会按公司供应商写回。
3. 工具文件里不再是 Dock 要维护的公司配置。插件自己不改工具文件，所以这一条靠 Magpie 接入时写下的网关配置。只改 Dock 的 `config.json`，运行中的页面不会跟着变。只改工具文件、`current` 仍是 `company:<tool>`，启动时 Dock 会把 `sk-` 写回去。

改完后插件退出并重新打开 Dock，等它写出启动对账。日志在 macOS 的 `~/Library/Logs/com.asteria.dock/Asteria Dock.log`。然后只检查这次命中的工具：`current` 仍是空，pin 键仍不在，公司记录上的 `sk-` 还在。

别的工具如果仍选着 Asteria，它们的 Dock 配置留着。这次对账写出的文件数可以不是 0。

## 各工具文件里有什么

插件不改这些文件。表里是 Dock 选 Asteria 时会写进去的东西，也是它和 Magpie 冲突的地方。

| 工具 | 文件 | Dock 选 Asteria 时写入 | Magpie 接入后应留下 |
| --- | --- | --- | --- |
| OpenCode | `~/.config/opencode/opencode.json` | `providers.asteria`、`asteria_dock`、`asteria/` 模型 | Magpie 自己的 provider 和网关地址 |
| Pi | `~/.pi/agent/settings.json`、`models.json` | `providers.asteria` | Magpie 的 provider |
| Codex | `~/.codex/config.toml` | `[model_providers.asteria]` 和公司 `sk-` | Magpie 的 provider。已经是官方的文件，清理时不重写 |
| Claude | `~/.claude/settings.json` | env 里的公司 `sk-` 和站点地址 | `ANTHROPIC_AUTH_TOKEN=magpie` 和 `ANTHROPIC_BASE_URL=http://127.0.0.1:3425` |
| Hermes | `~/.hermes/config.yaml` | 带中转地址、`sk-` 或 Dock 注释的行 | 没有这些标记的文件 |

Dock 写过的文件，第一行可能有 `# asteria_dock provider=... prev={...}`。`prev` 是切到公司供应商之前的字段。

公司 `providers[]` 里的 `status: supported`、`api_key`、`selected_model` 保持原样。清空的是「当前用哪家」，不是把公司 key 从 Dock 删掉。

## 常见清理问题

**只改 `current`，重启后又变回公司供应商。** 工具文件还是公司配置，或者 `company_pins.<tool>` 还在。启动对账以 live 文件和 pin 为准，会把 `current` 写回去。

**页面上切了官方，几秒后又写回。** 多半是 pin 键还在。界面手动切官方时，Dock 会把这个键整个删掉。空对象不算删掉。

**Claude 同时有 Magpie token 和公司 key。** Magpie 接入时写 `ANTHROPIC_AUTH_TOKEN=magpie` 和 `ANTHROPIC_BASE_URL=http://127.0.0.1:3425`。清理不删这两项。如果重启把它们盖掉了，插件按清理前的文件写回。

**登录会不会清掉 Magpie token。** 不会。登录会退出 Dock，清掉这些工具的公司选择，并去掉工具文件里的公司标记。Pi 去掉 `models.json` 里的 `asteria_dock` 和 `providers.asteria`。Magpie 的 key 和 `providers.magpie` 留着。没有已接入且正在使用这家供应商的 agent 时，登录不退出 Dock。

**清理失败后 Dock 被退出了。** 还没重新打开就失败时，插件会再打开一次 Dock。带 Magpie key 的工具文件如果被改过，会按清理前写回。

**路由组里有这家供应商，算不算正在使用。** 不算。只看这个 agent 当前选中的模型是不是 `dock`、`dock/...` 或 `dock-...`。

## 路径

macOS 上 Dock 配置在 `~/.asteria-dock/`。Windows 先找 `%LOCALAPPDATA%\AsteriaDock`，没有再找 `%USERPROFILE%\.asteria-dock`。退出和重新打开只在 macOS 上验证过。

## 插件市场

Magpie 插件市场扫的是 GitHub 仓库 topic `magpie-plugin`，查询是 `topic:magpie-plugin archived:false fork:false`。`package.json` 里的 `keywords` 只在包发到 npm 之后，才会出现在 npm 搜索结果里。

这个目录还没有 Git remote，所以现在扫不出来。要出现在市场里，仓库需要打上 `magpie-plugin` 这个 topic。仓库说明和代码里不要写公司站点地址。
