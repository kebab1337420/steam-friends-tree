-- Offline exercise of the Lua backend: fake Millennium modules, fake Steam Web API.
--
-- The stubs keep values as Lua tables instead of JSON text, so json.encode is
-- the identity and json.decode gives the table straight back. That lets the
-- test read snapshots directly without shipping a JSON parser here.
--
-- Run with: luajit tests/crawler.test.lua

package.path = "./?.lua;" .. package.path

local files = {}
local clock = 0

local stubs = {}

-- encode hands back an opaque token string that decode resolves, so the backend
-- keeps treating serialised values as text while the test reads real tables.
local encoded = {}
local token_seq = 0

stubs.json = {
	encode = function(value)
		token_seq = token_seq + 1
		local token = "json:" .. token_seq
		encoded[token] = value
		return token
	end,
	decode = function(value)
		if type(value) == "table" then return value end
		if encoded[value] then return encoded[value] end
		error("unexpected decode of " .. tostring(value))
	end,
}

--- Unwraps whatever an IPC function returned.
local function decoded(token) return stubs.json.decode(token) end

stubs.logger = {
	info = function() end,
	warn = function() end,
	error = function() end,
}

stubs.millennium = { ready = function() end }

stubs.fs = {
	exists = function(path) return files[path] ~= nil end,
}

stubs.utils = {
	time_ms = function() return clock end,
	url_encode = function(value) return value end,
	get_backend_path = function() return "/plugin/backend" end,
	read_file = function(path) return files[path] end,
	write_file = function(path, content) files[path] = content end,
}

-- graph: 1 -> 2,3 ; 2 -> 4,5 ; 3 -> 5,6 (5 shared) ; 4 private ; 6 flaky then ok
local GRAPH = {
	["1"] = { "2", "3" },
	["2"] = { "4", "5" },
	["3"] = { "5", "6" },
	["5"] = {},
	["6"] = { "7" },
	["7"] = {},
}
local PRIVATE = { ["4"] = true }
local flaky = { ["6"] = 2 }
local http_calls = 0

local function query_of(url)
	local out = {}
	for name, value in url:gmatch("([%w_]+)=([^&]*)") do out[name] = value end
	return out
end

stubs.http = {
	get = function(url, options)
		http_calls = http_calls + 1
		clock = clock + 10
		local query = query_of(url)
		if url:find("ResolveVanityURL", 1, true) then
			return { status = 200, body = stubs.json.encode({ response = { success = 1, steamid = "1" } }) }
		end
		if url:find("GetPlayerSummaries", 1, true) then
			local players = {}
			for id in query.steamids:gmatch("[^,]+") do
				players[#players + 1] = {
					steamid = id, personaname = "user" .. id, avatarmedium = "a" .. id,
					profileurl = "u" .. id, personastate = 1, communityvisibilitystate = 3,
				}
			end
			return { status = 200, body = stubs.json.encode({ response = { players = players } }) }
		end
		local steamid = query.steamid
		if PRIVATE[steamid] then return { status = 403, body = "" } end
		if (flaky[steamid] or 0) > 0 then
			flaky[steamid] = flaky[steamid] - 1
			return { status = 503, body = "" }
		end
		local friends = {}
		for _, id in ipairs(GRAPH[steamid] or {}) do friends[#friends + 1] = { steamid = id } end
		return { status = 200, body = stubs.json.encode({ friendslist = { friends = friends } }) }
	end,
}

local real_require = require
_G.require = function(name)
	if stubs[name] then return stubs[name] end
	return real_require(name)
end

local plugin = dofile("backend/main.lua")
_G.require = real_require

local KEY = "0123456789abcdef0123456789abcdef"
files["/plugin/backend/../config.json"] = stubs.json.encode({ api_key = KEY })
files["/plugin/backend/export_template.html"] = "<html>__TREE_DATA__</html>"

-- ---------------------------------------------------------------------------

local failures = {}

local function check(label, condition, detail)
	if condition then
		print("PASS  " .. label)
	else
		print("FAIL  " .. label .. (detail and (" :: " .. tostring(detail)) or ""))
		failures[#failures + 1] = label
	end
end

--- Runs a crawl to completion, returning the final snapshot.
--- Polls until the crawl in flight stops, whoever started it.
local function drain()
	for _ = 1, 200 do
		local snapshot = decoded(get_tree())
		if snapshot.status ~= "running" then return snapshot end
	end
	error("crawl never finished")
end

local function run(options)
	local result = decoded(start_crawl({
		root = options.root or "1",
		max_depth = options.max_depth or 9,
		unlimited = options.unlimited ~= false,
		node_budget = options.node_budget or 100,
		friends_per_node = options.friends_per_node or 0,
	}))
	if not result.ok then return result end
	local snapshot
	for _ = 1, 200 do
		snapshot = decoded(get_tree())
		if snapshot.status ~= "running" then return snapshot end
	end
	error("crawl never finished")
end

local function ids(snapshot)
	local out = {}
	for _, node in ipairs(snapshot.nodes) do out[#out + 1] = node.id end
	table.sort(out)
	return table.concat(out, ",")
end

local function status_of(snapshot, steamid)
	for _, node in ipairs(snapshot.nodes) do
		if node.id == steamid then return node.status end
	end
end

local function count(list, predicate)
	local total = 0
	for _, item in ipairs(list) do if predicate(item) then total = total + 1 end end
	return total
end

-- 1. full unbounded walk
local snapshot = run({})
check("full walk visits everyone", ids(snapshot) == "1,2,3,4,5,6,7", ids(snapshot))
check("tree has n-1 edges", #snapshot.edges == #snapshot.nodes - 1, #snapshot.edges)
check("shared friend kept once", count(snapshot.edges, function(e) return e.to == "5" end) == 1)
check("private profile flagged", status_of(snapshot, "4") == "private", status_of(snapshot, "4"))
check("flaky account recovered", status_of(snapshot, "6") == "ok", status_of(snapshot, "6"))
check("retries counted", snapshot.retries == 2, snapshot.retries)
check("names filled in", count(snapshot.nodes, function(n) return n.name ~= nil end) == #snapshot.nodes)
check("status done", snapshot.status == "done", snapshot.status)
check("not truncated", snapshot.truncated == false)
check("root status ok", snapshot.root_status == "ok", snapshot.root_status)

-- 2. depth limit
snapshot = run({ unlimited = false, max_depth = 1 })
check("depth 1 stops at first ring", ids(snapshot) == "1,2,3", ids(snapshot))
check("depth limit reports truncation", snapshot.truncated == true)

-- 3. node budget
snapshot = run({ node_budget = 3 })
check("budget caps node count", #snapshot.nodes <= 3, #snapshot.nodes)
check("budget reports truncation", snapshot.truncated == true)

-- 4. friends per node cap
snapshot = run({ friends_per_node = 1 })
check("friend cap keeps one branch", count(snapshot.edges, function(e) return e.from == "1" end) == 1)

-- 5. private root
snapshot = run({ root = "4" })
check("private root -> single node", #snapshot.nodes == 1, #snapshot.nodes)
check("private root reported", snapshot.root_status == "private", snapshot.root_status)

-- 6. restart drops the previous tree
start_crawl({ root = "1", max_depth = 9, unlimited = true, node_budget = 100 })
get_tree()
start_crawl({ root = "6", max_depth = 9, unlimited = true, node_budget = 100 })
for _ = 1, 200 do
	snapshot = decoded(get_tree())
	if snapshot.status ~= "running" then break end
end
check("restart keeps only the new tree", ids(snapshot) == "6,7", ids(snapshot))
check("restart root is the new one", snapshot.root == "6")

-- 7. key validation, persistence and error scrubbing
check("bad key refused", decoded(set_api_key("nope")).ok == false)
check("good key accepted", decoded(set_api_key(KEY)).ok == true)
check("key reported as present", decoded(get_config()).has_key == true)
check("last root remembered", decoded(get_config()).last_root == "6", decoded(get_config()).last_root)
check("root resolved from a profile URL",
	decoded(resolve_account("https://steamcommunity.com/profiles/76561197960287930")).steamid == "76561197960287930")
check("vanity name resolved", decoded(resolve_account("gaben")).steamid == "1")

-- 7b. argument shapes Millennium may hand over
local wrapped = stubs.json.encode({ root = "6", max_depth = 9, unlimited = true, node_budget = 100 })
check("options given as a named field", decoded(start_crawl({ options = wrapped })).ok == true)
check("options given positionally", decoded(start_crawl(wrapped)).ok == true)
check("profile start takes the profile as root",
	decoded(start_from_profile({ options = stubs.json.encode({ steamid = "6", persona = "user6" }) })).ok == true)
check("profile start refuses a missing account",
	decoded(start_from_profile({ options = stubs.json.encode({ persona = "user6" }) })).ok == false)

-- 7d. settings saved by the page, then reused by the profile-page button
save_options({ options = stubs.json.encode({
	max_depth = 1, unlimited = false, node_budget = 42, friends_per_node = 3,
}) })
local saved = decoded(get_config())
check("saved depth read back", saved.last_max_depth == 1, saved.last_max_depth)
check("saved budget read back", saved.last_node_budget == 42, saved.last_node_budget)
check("saved friend cap read back", saved.last_friends_per_node == 3, saved.last_friends_per_node)
start_from_profile({ options = stubs.json.encode({ steamid = "1" }) })
snapshot = drain()
check("profile start honours the saved depth", ids(snapshot) == "1,2,3", ids(snapshot))

-- 7c. HTML export
files["/plugin/tree.html"] = nil
snapshot = run({})
check("a finished walk writes the page on its own", files["/plugin/tree.html"] ~= nil)
check("the snapshot carries the page path", snapshot.export_path == "/plugin/tree.html", snapshot.export_path)
files["/plugin/tree.html"] = nil
local exported = decoded(export_html())
check("export reports a path", exported.ok == true and exported.path == "/plugin/tree.html", exported.path)
check("export writes the page", (files["/plugin/tree.html"] or ""):find("<html>", 1, true) == 1)
check("export carries the tree", files["/plugin/tree.html"]:find("json:", 1, true) ~= nil)
files["/plugin/backend/export_template.html"] = nil
check("export without a template fails", decoded(export_html()).ok == false)

-- 8. stop
start_crawl({ root = "1", max_depth = 9, unlimited = true, node_budget = 100 })
stop_crawl()
snapshot = decoded(get_tree())
check("stop halts the crawl", snapshot.status == "stopped", snapshot.status)

-- 9. no key at all
files["/plugin/backend/../config.json"] = stubs.json.encode({})
check("crawl refused without a key", decoded(start_crawl({ root = "1", max_depth = 9, unlimited = true, node_budget = 100 })).ok == false)
check("resolve refused without a key", decoded(resolve_account("gaben")).ok == false)

-- 10. lifecycle hooks Millennium calls
check("exports on_load", type(plugin.on_load) == "function")
check("exports on_frontend_loaded", type(plugin.on_frontend_loaded) == "function")
check("exports on_unload", type(plugin.on_unload) == "function")

print("")
print("FAILURES: " .. #failures)
os.exit(#failures > 0 and 1 or 0)
