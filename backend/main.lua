-- Steam Friends Tree - Millennium backend (Lua).
--
-- Crawls the Steam friend graph breadth-first from a chosen root account and
-- exposes the resulting tree to the frontend page. Everything goes through the
-- public Steam Web API, so a Web API key is required and private profiles come
-- back as leaves.
--
-- Millennium 3.x only runs Lua backends, and its Lua VM has no threads: the
-- crawl therefore advances in bounded slices. Every get_tree() call from the
-- page's poll loop does a little more work and returns the current snapshot,
-- which keeps each IPC round-trip short while the walk still progresses on its
-- own without the page having to drive it explicitly.

local json = require("json")
local http = require("http")
local logger = require("logger")
local millennium = require("millennium")
local utils = require("utils")
local fs = require("fs")

local API = "https://api.steampowered.com"

-- Hard ceilings, whatever the UI asks for. An unbounded crawl of the friend
-- graph never terminates on its own, so the node budget is what actually stops
-- it.
local MAX_NODE_BUDGET = 20000
local MAX_DEPTH_BUDGET = 12
local REQUEST_TIMEOUT = 15
-- Wall-clock budget for one slice of work, in milliseconds. Kept below the
-- page's poll interval so snapshots stay responsive.
local SLICE_MS = 700
-- Transient failures (5xx, dropped connections, rate limiting) are retried on
-- later slices instead of killing the crawl.
local MAX_ATTEMPTS = 3

-- Node statuses reported to the page.
local PENDING = "pending"   -- discovered, not expanded (depth or budget stopped us)
local OK = "ok"             -- friend list read
local PRIVATE = "private"   -- friend list not visible
local FAILED = "failed"     -- gave up after retries

-- ---------------------------------------------------------------------------
-- small helpers
-- ---------------------------------------------------------------------------

local function now_ms()
	local ok, value = pcall(function() return utils.time_ms() end)
	if ok and type(value) == "number" then return value end
	return os.time() * 1000
end

--- Marks a table so cjson encodes it as [] rather than {} when it is empty.
local function as_array(t)
	if #t == 0 then
		if json.empty_array ~= nil then return json.empty_array end
		if json.array_mt ~= nil then return setmetatable(t, json.array_mt) end
	end
	return t
end

local function is_hex_key(key)
	return type(key) == "string" and #key == 32 and key:match("^%x+$") ~= nil
end

--- Never let the API key reach the page or the log file.
local function scrub(text, key)
	text = tostring(text or "")
	if key and #key > 0 then
		text = text:gsub(key:gsub("%W", "%%%0"), "<cle>")
	end
	return text
end

local function url_encode(value)
	local ok, encoded = pcall(function() return utils.url_encode(tostring(value)) end)
	if ok and type(encoded) == "string" then return encoded end
	return tostring(value):gsub("[^%w%-%._~]", function(c)
		return string.format("%%%02X", string.byte(c))
	end)
end

-- ---------------------------------------------------------------------------
-- config
-- ---------------------------------------------------------------------------

local CONFIG_PATH
local TEMPLATE_PATH = "export_template.html"
local EXPORT_PATH = "tree.html"
do
	local ok, path = pcall(function() return utils.get_backend_path() end)
	if ok and type(path) == "string" and #path > 0 then
		local backend = path:gsub("[\\/]+$", "")
		CONFIG_PATH = backend .. "/../config.json"
		TEMPLATE_PATH = backend .. "/export_template.html"
		-- Beside the plugin itself, so the exported page is easy to find again.
		EXPORT_PATH = backend:gsub("[\\/]backend$", "") .. "/tree.html"
	else
		CONFIG_PATH = "config.json"
	end
end

local function read_config()
	local ok, raw = pcall(function()
		if not fs.exists(CONFIG_PATH) then return nil end
		return utils.read_file(CONFIG_PATH)
	end)
	if not ok or type(raw) ~= "string" or #raw == 0 then return {} end
	local parsed_ok, parsed = pcall(json.decode, raw)
	if not parsed_ok or type(parsed) ~= "table" then return {} end
	return parsed
end

local function write_config(cfg)
	local ok, err = pcall(function()
		utils.write_file(CONFIG_PATH, json.encode(cfg))
	end)
	if not ok then logger:warn("config write failed: " .. tostring(err)) end
end

local function api_key()
	local key = read_config().api_key
	if is_hex_key(key) then return key end
	return nil
end

-- ---------------------------------------------------------------------------
-- HTTP
-- ---------------------------------------------------------------------------

-- Millennium's http module answers with { status = number, body = string,
-- headers = table }.
local function http_call(url)
	local ok, response = pcall(function()
		return http.get(url, {
			timeout = REQUEST_TIMEOUT,
			follow_redirects = true,
			user_agent = "steam-friends-tree/1.0",
		})
	end)
	if not ok then return nil, tostring(response) end
	if type(response) ~= "table" then return nil, "reponse HTTP inattendue" end
	return response
end

--- Returns decoded body, http status, error message.
local function get_json(path, query)
	local parts = {}
	for name, value in pairs(query) do
		parts[#parts + 1] = name .. "=" .. url_encode(value)
	end
	local url = API .. path .. "?" .. table.concat(parts, "&")

	local response, err = http_call(url)
	if not response then return nil, 0, err or "requete impossible" end

	local status = tonumber(response.status) or 0
	local body = response.body
	if status < 200 or status >= 300 then
		return nil, status, "HTTP " .. tostring(status)
	end
	if type(body) ~= "string" or #body == 0 then return nil, status, "reponse vide" end

	local ok, decoded = pcall(json.decode, body)
	if not ok or type(decoded) ~= "table" then return nil, status, "JSON invalide" end
	return decoded, status, nil
end

-- ---------------------------------------------------------------------------
-- crawler state
-- ---------------------------------------------------------------------------

local state

local function reset_state()
	state = {
		status = "idle",     -- idle | running | done | stopped | error
		error = "",
		root = "",
		root_status = PENDING,
		expanded = 0,
		retries = 0,
		truncated = false,
		nodes = {},          -- steamid -> node
		order = {},          -- insertion order, so the page sees a stable list
		edges = {},
		queue = {},          -- list of steamids still to expand
		head = 1,            -- read cursor into queue
		pending_summaries = {},
		attempts = {},       -- steamid -> failed attempts so far
		max_depth = 1,
		unlimited = false,
		node_budget = MAX_NODE_BUDGET,
		friends_per_node = 0,
	}
end

reset_state()

local function add_node(steamid, depth)
	if state.nodes[steamid] then return state.nodes[steamid] end
	local node = { id = steamid, depth = depth, friends = nil, status = PENDING }
	state.nodes[steamid] = node
	state.order[#state.order + 1] = steamid
	state.pending_summaries[#state.pending_summaries + 1] = steamid
	return node
end

local function snapshot()
	local nodes = {}
	for _, steamid in ipairs(state.order) do
		local node = state.nodes[steamid]
		nodes[#nodes + 1] = {
			id = node.id,
			depth = node.depth,
			friends = node.friends,
			status = node.status,
			name = node.name,
			avatar = node.avatar,
			url = node.url,
			state = node.state,
			visibility = node.visibility,
		}
	end
	return json.encode({
		status = state.status,
		error = state.error,
		root = state.root,
		root_status = state.root_status,
		expanded = state.expanded,
		queued = math.max(0, #state.queue - state.head + 1),
		retries = state.retries,
		truncated = state.truncated,
		nodes = as_array(nodes),
		edges = as_array(state.edges),
		export_path = state.export_path or "",
		export_opened = state.export_opened == true,
	})
end

--- Hands the exported file to the operating system, which opens it in the
--- default browser. Returns false when the Lua VM refuses to spawn anything, in
--- which case the client page opens the file itself.
local function open_in_browser(path)
	local windows_path = path:gsub("/", "\\")
	local ok, result = pcall(function()
		return os.execute('start "" "' .. windows_path .. '"')
	end)
	if not ok then
		logger:warn("could not open the browser: " .. tostring(result))
		return false
	end
	logger:info("browser asked to open " .. windows_path)
	return true
end

--- Renders the tree to a standalone HTML page: the accounts, the edges and the
--- drawing code all live in the file, so it opens in any browser with no plugin
--- and no server involved.
local function write_export()
	local data = json.decode(snapshot())
	if type(data.nodes) ~= "table" or #data.nodes == 0 then
		return false, "Aucun arbre a exporter."
	end

	local template
	local read_ok = pcall(function() template = utils.read_file(TEMPLATE_PATH) end)
	if not read_ok or type(template) ~= "string" or #template == 0 then
		return false, "Modele d'export introuvable : " .. TEMPLATE_PATH
	end

	data.generated_at = os.date("%Y-%m-%d %H:%M")
	-- The payload sits inside a script element, so a closing tag it happens to
	-- contain has to be escaped.
	local payload = json.encode(data):gsub("</", "<\\/")
	local page = template:gsub("__TREE_DATA__", function() return payload end)

	local written, err = pcall(function() utils.write_file(EXPORT_PATH, page) end)
	if not written then
		return false, "Ecriture impossible (" .. EXPORT_PATH .. ") : " .. tostring(err)
	end
	state.export_path = EXPORT_PATH
	logger:info("tree exported to " .. EXPORT_PATH .. " (" .. #data.nodes .. " comptes)")
	state.export_opened = open_in_browser(EXPORT_PATH)
	return true, EXPORT_PATH
end

-- ---------------------------------------------------------------------------
-- crawl steps
-- ---------------------------------------------------------------------------

--- Reads one friend list. Returns a list of steamids, or nil plus a status
--- among PRIVATE / FAILED / "retry".
local function friend_list(key, steamid)
	local data, status, err = get_json("/ISteamUser/GetFriendList/v1/", {
		key = key, steamid = steamid, relationship = "friend",
	})
	if data then
		local friends = {}
		local list = data.friendslist and data.friendslist.friends
		if type(list) == "table" then
			for _, entry in ipairs(list) do
				if entry.steamid then friends[#friends + 1] = tostring(entry.steamid) end
			end
		end
		return friends, nil
	end
	if status == 401 or status == 403 then return nil, PRIVATE end

	local attempts = (state.attempts[steamid] or 0) + 1
	state.attempts[steamid] = attempts
	state.retries = state.retries + 1
	if attempts >= MAX_ATTEMPTS then
		logger:warn("friend list gave up for " .. steamid .. ": " .. scrub(err, key))
		return nil, FAILED
	end
	return nil, "retry"
end

--- Fills names and avatars for up to 100 discovered accounts.
local function fill_summaries(key)
	local batch = {}
	while #batch < 100 and #state.pending_summaries > 0 do
		batch[#batch + 1] = table.remove(state.pending_summaries, 1)
	end
	if #batch == 0 then return end

	local data = get_json("/ISteamUser/GetPlayerSummaries/v2/", {
		key = key, steamids = table.concat(batch, ","),
	})
	local players = data and data.response and data.response.players
	if type(players) ~= "table" then return end
	for _, player in ipairs(players) do
		local node = state.nodes[tostring(player.steamid or "")]
		if node then
			node.name = player.personaname
			node.avatar = player.avatarmedium
			node.url = player.profileurl
			node.state = player.personastate
			node.visibility = player.communityvisibilitystate
		end
	end
end

--- One expansion: pops a node off the queue and reads its friend list.
local function expand_one(key)
	local steamid = state.queue[state.head]
	if steamid == nil then return false end

	local node = state.nodes[steamid]
	if node == nil then
		state.head = state.head + 1
		return true
	end

	local friends, failure = friend_list(key, steamid)
	if failure == "retry" then
		-- Leave it in place; the next slice tries again.
		return true
	end
	state.head = state.head + 1

	if failure ~= nil then
		node.status = failure
		node.friends = 0
		if steamid == state.root then state.root_status = failure end
		return true
	end

	node.status = OK
	node.friends = #friends
	if steamid == state.root then state.root_status = OK end
	state.expanded = state.expanded + 1

	local kept = 0
	for _, friend in ipairs(friends) do
		if state.friends_per_node > 0 and kept >= state.friends_per_node then
			state.truncated = true
			break
		end
		if not state.nodes[friend] then
			if #state.order >= state.node_budget then
				state.truncated = true
				break
			end
			local child = add_node(friend, node.depth + 1)
			state.edges[#state.edges + 1] = { from = steamid, to = friend }
			kept = kept + 1
			if state.unlimited or child.depth < state.max_depth then
				state.queue[#state.queue + 1] = friend
			else
				state.truncated = true
			end
		end
	end
	return true
end

--- Advances the crawl for at most SLICE_MS milliseconds.
local function advance()
	if state.status ~= "running" then return end

	local key = api_key()
	if not key then
		state.status = "error"
		state.error = "Cle Web API absente ou invalide."
		return
	end

	local deadline = now_ms() + SLICE_MS
	repeat
		if #state.pending_summaries > 0 then
			fill_summaries(key)
		elseif state.head <= #state.queue then
			expand_one(key)
		else
			break
		end
	until now_ms() >= deadline

	if state.head > #state.queue and #state.pending_summaries == 0 then
		state.status = "done"
		-- The page is written as soon as the walk ends, so it is always there
		-- without anyone having to ask for it.
		local ok, detail = write_export()
		if not ok then logger:warn("automatic export failed: " .. tostring(detail)) end
	end
end

-- ---------------------------------------------------------------------------
-- IPC surface (global functions are what Millennium exposes to the frontend)
-- ---------------------------------------------------------------------------

--- Millennium may hand a callable's argument over as the value itself or as a
--- table keyed by the parameter name; both are unwrapped here so no assumption
--- is made about how arguments are ordered on the way in.
local function scalar(value, name)
	if type(value) == "table" then
		local named = value[name]
		if named ~= nil then return named end
		return value[1]
	end
	return value
end

--- Same unwrapping, for the parameters carried as one JSON object. A table
--- that carries neither the named field nor a positional one is already the
--- payload itself.
local function payload(value, name)
	if type(value) == "table" then
		if value[name] ~= nil then
			value = value[name]
		elseif value[1] ~= nil then
			value = value[1]
		end
	end
	if type(value) == "string" then
		local ok, decoded = pcall(json.decode, value)
		if ok and type(decoded) == "table" then return decoded end
	end
	if type(value) == "table" then return value end
	return {}
end

function get_config()
	local cfg = read_config()
	return json.encode({
		has_key = is_hex_key(cfg.api_key),
		last_root = cfg.last_root or "",
		max_node_budget = MAX_NODE_BUDGET,
		max_depth = MAX_DEPTH_BUDGET,
	})
end

function set_api_key(api_key)
	api_key = tostring(scalar(api_key, "api_key") or ""):gsub("%s", "")
	if not is_hex_key(api_key) then
		return json.encode({ ok = false, error = "Cle Web API invalide (32 caracteres hexadecimaux attendus)." })
	end
	local cfg = read_config()
	cfg.api_key = api_key
	write_config(cfg)
	return json.encode({ ok = true })
end

function resolve_account(query)
	query = tostring(scalar(query, "query") or ""):gsub("^%s+", ""):gsub("%s+$", "")
	if #query == 0 then
		return json.encode({ ok = false, error = "Indique un SteamID64, une URL de profil ou un pseudo d'URL." })
	end

	local key = api_key()
	if not key then
		return json.encode({ ok = false, error = "Cle Web API absente ou invalide." })
	end

	-- A profile URL carries either the id64 or the vanity name.
	local vanity = query:match("steamcommunity%.com/id/([^/?#]+)")
	local direct = query:match("steamcommunity%.com/profiles/(%d+)") or query:match("^(%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d%d)$")
	if direct then return json.encode({ ok = true, steamid = direct }) end
	vanity = vanity or query

	local data, _, err = get_json("/ISteamUser/ResolveVanityURL/v1/", { key = key, vanityurl = vanity })
	local response = data and data.response
	if response and tonumber(response.success) == 1 and response.steamid then
		return json.encode({ ok = true, steamid = tostring(response.steamid) })
	end
	return json.encode({ ok = false, error = scrub(err or "Compte introuvable.", key) })
end

--- Starts a walk from an already validated options table.
local function begin_crawl(options)
	local root = tostring(options.root or "")
	if root:match("^%d+$") == nil then
		return json.encode({ ok = false, error = "Racine invalide." })
	end
	if not api_key() then
		return json.encode({ ok = false, error = "Cle Web API absente ou invalide." })
	end

	local depth = math.max(1, math.min(math.floor(tonumber(options.max_depth) or 1), MAX_DEPTH_BUDGET))
	local budget = math.max(1, math.min(math.floor(tonumber(options.node_budget) or MAX_NODE_BUDGET), MAX_NODE_BUDGET))
	local per_node = math.max(0, math.floor(tonumber(options.friends_per_node) or 0))
	local unlimited = options.unlimited
	unlimited = (unlimited == true or unlimited == "true" or unlimited == 1)

	reset_state()
	state.status = "running"
	state.root = root
	state.max_depth = depth
	state.unlimited = unlimited
	state.node_budget = budget
	state.friends_per_node = per_node

	add_node(root, 0)
	state.queue[1] = root

	-- Remembered so a crawl started from a profile page reuses the settings the
	-- page was last configured with.
	local cfg = read_config()
	cfg.last_root = root
	cfg.last_max_depth = depth
	cfg.last_unlimited = unlimited
	cfg.last_node_budget = budget
	cfg.last_friends_per_node = per_node
	write_config(cfg)

	return json.encode({ ok = true, error = "" })
end

--- The frontend sends its options as one JSON string, so nothing here depends
--- on how Millennium orders a call's arguments.
function start_crawl(options)
	return begin_crawl(payload(options, "options"))
end

--- Entry point for the button the webkit module adds to Steam profile pages.
--- The account is taken as the root, everything else comes from the last crawl
--- the page ran.
function start_from_profile(options)
	options = payload(options, "options")
	local steamid = tostring(options.steamid or "")
	local cfg = read_config()

	local result = begin_crawl({
		root = steamid,
		max_depth = cfg.last_max_depth or 2,
		unlimited = cfg.last_unlimited == true,
		node_budget = cfg.last_node_budget or 400,
		friends_per_node = cfg.last_friends_per_node or 0,
	})

	local decoded = json.decode(result)
	if decoded.ok then
		logger:info("crawl started from a profile page: " .. steamid)
		-- Best effort: the client page may not be mounted, and the crawl runs
		-- either way.
		pcall(function()
			millennium.call_frontend_method("notifyTreeStarted",
				{ steamid, tostring(options.persona or "") })
		end)
	end
	return result
end

--- Writes the page on demand; the walk writes it on its own when it ends.
function export_html()
	local ok, detail = write_export()
	if not ok then return json.encode({ ok = false, error = detail }) end
	return json.encode({ ok = true, path = detail, opened = state.export_opened == true })
end

function stop_crawl()
	if state.status == "running" then
		state.status = "stopped"
		-- Whatever was reached so far is still worth a page.
		local ok, detail = write_export()
		if not ok then logger:warn("export after stop failed: " .. tostring(detail)) end
	end
	return json.encode({ ok = true })
end

function get_tree()
	local ok, err = pcall(advance)
	if not ok then
		state.status = "error"
		state.error = scrub(err, api_key())
		logger:warn("crawl failed: " .. state.error)
	end
	return snapshot()
end

-- ---------------------------------------------------------------------------
-- plugin lifecycle
-- ---------------------------------------------------------------------------

local function on_load()
	logger:info("Steam Friends Tree backend loaded")
	-- Whether the export can hand the page to the browser itself is decided by
	-- the host VM, so it is worth knowing from the log.
	logger:info("os.execute is " .. type(os.execute) .. ", export goes to " .. EXPORT_PATH)
	millennium.ready()
end

local function on_frontend_loaded()
	logger:info("Frontend loaded")
end

local function on_unload()
	logger:info("Steam Friends Tree backend unloaded")
end

return {
	on_load = on_load,
	on_frontend_loaded = on_frontend_loaded,
	on_unload = on_unload,
}
