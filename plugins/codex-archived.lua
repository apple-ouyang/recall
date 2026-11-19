-- Same Codex rollout format as the built-in adapter, but for archived_sessions.
-- Uses a distinct source id so it does not replace ~/.codex/sessions.
local ARG_KEYS = { "command", "path", "query", "pattern", "file_path" }

local function arg_summary_raw(raw)
  if type(raw) ~= "string" or raw == "" then
    return nil
  end
  local obj = recall.json(raw)
  if type(obj) ~= "table" then
    return nil
  end
  for _, k in ipairs(ARG_KEYS) do
    local v = obj[k]
    if type(v) == "string" and v ~= "" then
      v = v:gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1")
      if #v > 70 then
        v = v:sub(1, 70) .. "\u{2026}"
      end
      return v
    end
  end
  return nil
end

local function join_text(parts)
  if type(parts) ~= "table" then
    return ""
  end
  local out = {}
  for _, p in ipairs(parts) do
    if p.text and p.text ~= "" then
      out[#out + 1] = p.text
    end
  end
  return table.concat(out, "\n")
end

return {
  id = "codex-archived",
  kind = "line",
  roots = { "~/.codex/archived_sessions" },
  glob = "rollout-*.jsonl",
  resume = "codex resume {id}",

  line = function(line, st)
    local t = recall.get(line, "type")
    if t == "session_meta" then
      st.id = recall.get(line, "payload.id") or st.id
      st.project = recall.get(line, "payload.cwd") or st.project
      st.started_at = recall.time(recall.get(line, "payload.timestamp"), "rfc3339")
      return nil
    end
    if t ~= "response_item" then
      return nil
    end

    local it = recall.get(line, "payload.type")
    local role, text
    if it == "message" then
      role = recall.get(line, "payload.role")
      text = join_text(recall.get(line, "payload.content"))
    elseif it == "function_call" then
      local nm = recall.get(line, "payload.name") or ""
      role = "tool:" .. nm
      text = arg_summary_raw(recall.get(line, "payload.arguments"))
        or recall.truncate(recall.get(line, "payload.arguments") or "", 400)
    elseif it == "function_call_output" then
      role = "tool"
      local o = recall.get(line, "payload.output")
      local s = type(o) == "string" and o or (type(o) == "table" and (o.content or "") or "")
      text = recall.truncate(s, 400)
    else
      return nil
    end
    if not text or text == "" then
      return nil
    end
    return { role = role, ts = recall.time(recall.get(line, "timestamp"), "rfc3339"), text = text }
  end,
}
