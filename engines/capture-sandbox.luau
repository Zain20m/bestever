-- capture-sandbox.luau
-- Runs a loader in Lune. HttpGet/request are real. CDN init URLs return the
-- vendored Luarmor client (CDN is IP-gated). Every loadstring/HTTP body is saved.
-- 401/403 are sneak-through: retry executor UAs, keep lua bodies.

local fs = require("@lune/fs")
local process = require("@lune/process")
local net = require("@lune/net")
local task = require("@lune/task")
local luau = require("@lune/luau")
local serde = require("@lune/serde")

local inputPath = process.args[1]
local outDir = process.args[2]
local scriptKey = process.args[3] or ""
local clientPath = process.args[4] or ""
local budget = tonumber(process.args[5] or "") or 45

if not inputPath or not outDir then
	print("[!] usage: lune run capture-sandbox.luau <input> <outdir> [script_key] [client.lua] [budget]")
	process.exit(2)
end

if not fs.isDir(outDir) then
	fs.writeDir(outDir)
end

local function write(name, body)
	fs.writeFile(outDir .. "/" .. name, body)
end

local captures = 0
local function saveCapture(kind, body)
	if type(body) ~= "string" or #body < 40 then
		return
	end
	captures += 1
	local n = string.format("%02d_%s_%d.lua", captures, kind, #body)
	write(n, body)
	print(string.format("[+] captured %s %d bytes -> %s", kind, #body, n))
	if string.find(body, "Luraph Obfuscator", 1, true) then
		write("LURAPH.lua", body)
		print("[+] luraph payload saved")
	end
	if string.find(body, "This script is obfuscated with MoonVeil", 1, true) then
		write("MOONVEIL.lua", body)
	end
end

local vendored = ""
if clientPath ~= "" and fs.isFile(clientPath) then
	vendored = fs.readFile(clientPath)
	print("[*] vendored luarmor client " .. #vendored .. " bytes")
end

local function isInitUrl(url)
	url = string.lower(tostring(url or ""))
	return string.find(url, "v4_init", 1, true)
		or (string.find(url, "cdn.luarmor.net/", 1, true) and string.find(url, "init", 1, true))
end

local function isBlockedSite(url)
	url = string.lower(tostring(url or ""))
	if string.find(url, "luarmor.net/login", 1, true) then
		return true
	end
	if string.find(url, "docs.luarmor.net", 1, true) then
		return true
	end
	if url == "https://luarmor.net/" or url == "https://luarmor.net" then
		return true
	end
	if string.find(url, "fonts.googleapis", 1, true) then
		return true
	end
	if string.find(url, "discord.gg", 1, true) then
		return true
	end
	return false
end

local UAS = {
	"Xeno/RobloxApp/V1.0.9",
	"Roblox/WinInet",
	"RobloxStudio/WinInet",
	"Wave",
	"Solara/2.0",
	"Synapse",
	"Krnl",
}

local function isDenied(status, body)
	status = tonumber(status) or 0
	body = tostring(body or "")
	if status == 401 or status == 403 then
		return true
	end
	local head = string.sub(string.lower(body), 1, 400)
	if string.find(head, "unauthorized", 1, true) and #body < 4000 then
		return true
	end
	if string.find(head, "host returned 403", 1, true) then
		return true
	end
	if string.find(head, "executor is not supported", 1, true) then
		return true
	end
	return false
end

local function looksLua(body)
	if type(body) ~= "string" or #body < 40 then
		return false
	end
	if string.find(body, "_bsdata0", 1, true) then
		return true
	end
	if string.find(body, "Luraph Obfuscator", 1, true) then
		return true
	end
	if string.find(body, "loadstring", 1, true) then
		return true
	end
	if string.find(body, "function", 1, true) and not string.find(body, "<html", 1, true) then
		return true
	end
	return false
end

local function rawGet(url, ua)
	local ok, res = pcall(function()
		return net.request({
			url = url,
			method = "GET",
			headers = {
				["User-Agent"] = ua,
				["Accept"] = "*/*",
				["Referer"] = "https://www.roblox.com/",
				["Origin"] = "https://www.roblox.com",
			},
		})
	end)
	if not ok then
		return false, tostring(res), 0
	end
	return true, res.body or "", tonumber(res.statusCode) or 0
end

local function httpGet(url, headers)
	url = tostring(url or "")
	if url == "" or isBlockedSite(url) then
		return ""
	end
	if isInitUrl(url) and #vendored > 2000 then
		print("[*] injecting vendored/live client for " .. url)
		saveCapture("init_injected", vendored)
		return vendored
	end
	print("[*] GET " .. url)
	local bestBody = ""
	local bestStatus = 0
	local startUa = (headers and (headers["User-Agent"] or headers["user-agent"])) or UAS[1]
	local list = { startUa }
	for _, ua in ipairs(UAS) do
		if ua ~= startUa then
			table.insert(list, ua)
		end
	end
	for _, ua in ipairs(list) do
		local ok, body, status = rawGet(url, ua)
		if not ok then
			print("[!] GET threw " .. tostring(body) .. " ua=" .. ua)
			if string.find(string.lower(tostring(body)), "403", 1, true) or string.find(string.lower(tostring(body)), "unauthor", 1, true) then
				-- sneak: try next UA
			else
				-- keep trying
			end
		else
			print(string.format("[*] GET %s -> %s %d bytes (%s)", url, tostring(status), #body, ua))
			if looksLua(body) and not isDenied(status, body) then
				if #body > 80 then
					saveCapture("http", body)
				end
				return body
			end
			if looksLua(body) and #body > #bestBody then
				bestBody = body
				bestStatus = status
			end
			if isDenied(status, body) then
				print("[!] " .. tostring(status) .. " unauthorized — sneaking next UA")
			end
		end
	end
	if isInitUrl(url) and #vendored > 2000 then
		print("[*] CDN 403/blocked — injecting client")
		saveCapture("init_injected", vendored)
		return vendored
	end
	if #bestBody > 80 then
		print("[+] sneak-through kept " .. #bestBody .. " bytes after 403")
		saveCapture("http_sneak", bestBody)
		return bestBody
	end
	return ""
end

local start = os.clock()
local function timedOut()
	return os.clock() - start > budget
end

local function proxy(name)
	local self = { __name = name }
	return setmetatable(self, {
		__index = function(_, k)
			if timedOut() then
				error("budget")
			end
			k = tostring(k)
			if k == "HttpGet" or k == "HttpGetAsync" then
				return function(_, url)
					return httpGet(url)
				end
			end
			if k == "GetService" then
				return function(_, svc)
					return proxy(tostring(svc))
				end
			end
			if k == "Kick" then
				return function(_, msg)
					print("[kick] " .. tostring(msg))
					error("kicked")
				end
			end
			if k == "Wait" or k == "wait" then
				return function()
					return task.wait(0)
				end
			end
			if k == "Connect" or k == "connect" then
				return function()
					return {
						Disconnect = function() end,
						disconnect = function() end,
					}
				end
			end
			if k == "Fire" or k == "FireServer" or k == "InvokeServer" or k == "Destroy" then
				return function() end
			end
			if k == "LocalPlayer" or k == "Players" then
				return proxy(k)
			end
			return proxy(name .. "." .. k)
		end,
		__newindex = function() end,
		__call = function()
			return proxy(name .. "()")
		end,
		__tostring = function()
			return name
		end,
	})
end

local lsIdx = 0

local function hookedLoad(src, chunk)
	if type(src) ~= "string" then
		return function() end
	end
	-- Same dump the executor hook does: writefile("loadstringN.txt", chunk)
	local dumpName = "loadstring" .. tostring(lsIdx) .. ".txt"
	lsIdx += 1
	write(dumpName, src)
	print("[+] writefile " .. dumpName .. " " .. #src .. " bytes")
	saveCapture("loadstring", src)
	src = src:gsub("while%s+true%s+do%s+end", "error('anti-tamper')")
	src = src:gsub("while%s+not%s+%w+%s+do%s+end", "task.wait(0)")
	local ok, fn = pcall(luau.load, src, { debugName = chunk or "captured", environment = _G })
	if ok and type(fn) == "function" then
		return fn
	end
	print("[!] load failed " .. tostring(fn))
	return function() end
end

local function vec()
	return { X = 0, Y = 0, Z = 0, Magnitude = 0 }
end

_G.script_key = scriptKey
_G.getgenv = function()
	return _G
end
_G.getrenv = function()
	return _G
end
_G.game = proxy("game")
_G.workspace = proxy("Workspace")
_G.Workspace = _G.workspace
_G.script = proxy("script")
_G.shared = _G.shared or {}
_G.loadstring = hookedLoad
_G.load = hookedLoad
_G.ce_like_loadstring_fn = hookedLoad
_G.LUARMOR_SkipAntidebugDevMode = true
_G.LUARMOR_AllowKeyCheckSkip = true
_G.tick = os.clock
_G.wait = function()
	return task.wait(0)
end
_G.spawn = function(fn)
	if type(fn) == "function" then
		pcall(fn)
	end
end
_G.delay = function(_, fn)
	if type(fn) == "function" then
		pcall(fn)
	end
end
_G.task = {
	wait = function()
		return task.wait(0)
	end,
	spawn = _G.spawn,
	defer = _G.spawn,
	delay = _G.delay,
}
_G.warn = print
_G.typeof = type
_G.identifyexecutor = function()
	return "Xeno", "1.0.9"
end
_G.getexecutorname = _G.identifyexecutor
_G.request = function(opts)
	opts = opts or {}
	local url = opts.Url or opts.url
	local hdrs = opts.Headers or opts.headers
	local body = httpGet(url, hdrs)
	-- never surface 403 to the loader — pretend success so it continues
	return { StatusCode = 200, Body = body, Headers = {}, Success = true, StatusMessage = "OK" }
end
_G.http_request = _G.request
_G.syn = { request = _G.request }
_G.http = { request = _G.request }
_G.crypt = {
	base64encode = function(s)
		return serde.encode("base64", tostring(s))
	end,
	base64decode = function(s)
		local ok, v = pcall(serde.decode, "base64", tostring(s))
		return ok and v or ""
	end,
	hash = function()
		return string.rep("0", 64)
	end,
}
_G.writefile = function(name, data)
	local body = tostring(data or "")
	local file = tostring(name or "")
	if file == "" then
		file = "loadstring" .. tostring(lsIdx) .. ".txt"
		lsIdx += 1
	end
	file = string.gsub(file, "[\\/]", "_")
	write(file, body)
	print("[+] writefile " .. file .. " " .. #body .. " bytes")
	saveCapture("writefile", body)
end
_G.readfile = function()
	return nil
end
_G.isfile = function()
	return false
end
_G.isfolder = function()
	return false
end
_G.makefolder = function() end
_G.appendfile = function() end
_G.delfile = function() end
_G.listfiles = function()
	return {}
end
_G.setclipboard = function() end
_G.UserSettings = function()
	return proxy("UserSettings")
end
_G.settings = function()
	return proxy("settings")
end
_G.Instance = {
	new = function(cls)
		return proxy(tostring(cls))
	end,
}
_G.Vector3 = { new = vec, zero = vec() }
_G.Vector2 = { new = function()
	return { X = 0, Y = 0 }
end }
_G.CFrame = { new = function()
	return {}
end, identity = {} }
_G.Color3 = {
	fromRGB = function()
		return {}
	end,
	new = function()
		return {}
	end,
}
_G.UDim2 = {
	new = function()
		return {}
	end,
	fromOffset = function()
		return {}
	end,
	fromScale = function()
		return {}
	end,
}
_G.UDim = { new = function()
	return {}
end }
_G.Enum = setmetatable({}, {
	__index = function()
		return setmetatable({}, {
			__index = function()
				return 0
			end,
		})
	end,
})
_G.Drawing = {
	new = function()
		return proxy("Drawing")
	end,
}
_G.gethui = function()
	return proxy("CoreGui")
end
_G.cloneref = function(v)
	return v
end
_G.clonefunction = function(v)
	return v
end
_G.newcclosure = function(v)
	return v
end
_G.hookfunction = function(a)
	return a
end
_G.checkcaller = function()
	return true
end
_G.Xeno = true
_G._VERSION = "Luau"

local src = fs.readFile(inputPath)
if scriptKey ~= "" and not string.find(src, "script_key", 1, true) then
	src = "script_key = " .. string.format("%q", scriptKey) .. "\n" .. src
end
saveCapture("input", src)

local okLoad, chunk = pcall(luau.load, src, { debugName = "loader", environment = _G })
if not okLoad then
	print("[!] parse failed " .. tostring(chunk))
	write("error.txt", tostring(chunk))
	process.exit(0)
end

local done = false
task.spawn(function()
	local ok, err = pcall(chunk)
	if not ok then
		print("[!] run " .. tostring(err))
		write("run_error.txt", tostring(err))
	end
	done = true
end)

while not done and not timedOut() do
	task.wait(0.05)
end
if not done then
	print("[!] budget reached, keeping captures")
	write("timeout.txt", "budget")
end
print(string.format("[*] done captures=%d elapsed=%.1fs", captures, os.clock() - start))
