-- Oh My Agy (`oma`) Tern Host reopen plugin.
-- Aligns with Tern 0.9.29+ `ReopenEvent`:
--   { pane, cwd, shell, agent, session, how, command, line }
tern.on("reopen", function(ev)
    if ev.agent ~= "omp" then
        return nil
    end

    local is_oma_cmd = ev.line ~= nil and (
        string.find(ev.line, "^%s*oma%f[%W]") ~= nil
        or string.find(ev.line, "[/\\]oma%f[%W]") ~= nil
        or string.find(ev.line, "oma%.exe") ~= nil
    )
    local is_oma_session = ev.session ~= nil
        and string.find(ev.session, "[/\\]oma[/\\]sessions[/\\]") ~= nil

    if is_oma_cmd or is_oma_session then
        return "oma"
    end

    return nil
end)
