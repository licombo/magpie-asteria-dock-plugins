// Asteria Dock's Anthropic endpoint deserializes a tool_addition's tool as
// tool_reference only. Claude Code (inline-tools-2026-09-15) writes the loaded
// MCP tool inline as tool_definition, and Dock answers 422
// "unknown variant `tool_definition`, expected `tool_reference`".
// Magpie hoists that shape only for api.deepseek.com, so a self-hosted Dock
// relay never sees the rewrite. This runs on the dock try alone.

export function rewriteInlineTools(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return false

  const tools = Array.isArray(body.tools) ? body.tools.slice() : []
  const have = new Set(tools.map((tool) => tool && tool.name).filter(Boolean))
  let toolsChanged = false
  let changed = false
  const messages = []

  for (const message of body.messages) {
    if (!message || !Array.isArray(message.content)) {
      messages.push(message)
      continue
    }
    let touched = false
    const content = message.content.map((block) => {
      const next = rewriteBlock(block, tools, have)
      if (next.added) toolsChanged = true
      if (next.block !== block) {
        touched = true
        changed = true
      }
      return next.block
    })
    messages.push(touched ? { ...message, content } : message)
  }

  if (!changed && !toolsChanged) return false
  body.messages = messages
  if (toolsChanged) body.tools = tools
  return true
}

function rewriteBlock(block, tools, have) {
  if (!block || typeof block !== "object") return { block, added: false }

  if (block.type === "tool_addition" && block.tool && block.tool.type === "tool_definition") {
    const definition = schemaOf(block.tool)
    const name = toolName(definition) || toolName(block.tool)
    if (!name) return { block, added: false }
    return {
      block: { ...block, tool: { type: "tool_reference", tool_name: name } },
      added: addTool(definition, tools, have),
    }
  }

  if (block.type === "tool_result" && Array.isArray(block.content)) {
    let nested = false
    let added = false
    const content = block.content.map((item) => {
      if (!item || item.type !== "tool_definition") return item
      const definition = schemaOf(item)
      const name = toolName(definition) || toolName(item)
      if (!name) return item
      nested = true
      if (addTool(definition, tools, have)) added = true
      return { type: "tool_reference", tool_name: name }
    })
    if (!nested) return { block, added: false }
    return { block: { ...block, content }, added }
  }

  return { block, added: false }
}

function schemaOf(tool) {
  if (!tool || typeof tool !== "object") return undefined
  if (tool.definition && typeof tool.definition === "object") return tool.definition
  if (typeof tool.name === "string" && tool.name) {
    const { type, definition, ...rest } = tool
    return rest
  }
  return undefined
}

function addTool(definition, tools, have) {
  const name = toolName(definition)
  if (!name || have.has(name)) return false
  tools.push(definition)
  have.add(name)
  return true
}

function toolName(value) {
  if (!value || typeof value !== "object") return ""
  const name = value.name || value.tool_name
  return typeof name === "string" ? name : ""
}
