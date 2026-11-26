import http from "node:http";

export async function startServer() {
  const state = {
    buckets: {},
    events: {},
    settings: {},
    nextId: 1,
    requests: [],
    eventPosts: 0,
    settingsPosts: 0,
    faults: {},
  };
  const server = http.createServer((req, res) => handle(req, res, state));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  if (port === 5600) throw new Error("synthetic server bound port 5600");
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function handle(req, res, state) {
  const url = new URL(req.url, "http://127.0.0.1");
    state.requests.push({ method: req.method, path: url.pathname, search: url.search });
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "bad json" });
      }
    }
    route(req, res, state, url, body);
  });
}

function route(req, res, state, url, body) {
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/0/info") {
    return send(res, 200, { version: "synthetic", testing: true, device_id: "synthetic", hostname: "synthetic" });
  }
  if (req.method === "GET" && path === "/api/0/buckets") {
    return redirect(req, res, "/api/0/buckets/");
  }
  if (req.method === "GET" && path === "/api/0/buckets/") {
    if (state.faults.redirectReads) return redirect(req, res, state.faults.redirectReads);
    return send(res, 200, state.buckets);
  }
  if (req.method === "POST" && path === "/api/0/query") {
    return redirect(req, res, "/api/0/query/");
  }
  const bucketCreate = path.match(/^\/api\/0\/buckets\/([^/]+)$/);
  if (bucketCreate && req.method === "POST") {
    const id = decodeURIComponent(bucketCreate[1]);
    state.buckets[id] = { id, ...body };
    state.events[id] ??= [];
    return send(res, 200, null, true);
  }
  const eventsPath = path.match(/^\/api\/0\/buckets\/([^/]+)\/events$/);
  if (eventsPath && req.method === "GET") {
    const id = decodeURIComponent(eventsPath[1]);
    if (!state.events[id]) return send(res, 404, { error: "missing" });
    const limit = Number(url.searchParams.get("limit") ?? "10000");
    return send(res, 200, state.events[id].slice(0, limit));
  }
  if (eventsPath && req.method === "POST") {
    const id = decodeURIComponent(eventsPath[1]);
    if (state.faults.redirectEventWrite) {
      state.faults.redirectEventWrite = false;
      return redirect(req, res, `/api/0/buckets/${eventsPath[1]}/events`);
    }
    if (!state.events[id]) return send(res, 404, { error: "missing" });
    if (state.faults.failWhenPostsAt === state.eventPosts) {
      state.faults.failWhenPostsAt = -1;
      return send(res, 400, { error: "rejected" });
    }
    let saved;
    try {
      saved = applyEvents(state, id, body);
    } catch (error) {
      return send(res, error.status || 500, { error: "rejected" });
    }
    state.eventPosts += 1;
    if (state.faults.dropEventWrite) {
      state.faults.dropEventWrite = false;
      res.destroy();
      return;
    }
    return send(res, 200, saved);
  }
  if (req.method === "POST" && path === "/api/0/query/") {
    const query = body?.query?.[0] ?? "";
    const match = query.match(/^events = query_bucket\(("(?:\\.|[^"\\])*")\);\nRETURN = events;$/);
    if (!match) return send(res, 400, { error: "unsupported query" });
    const bucketId = JSON.parse(match[1]);
    if (!state.events[bucketId]) return send(res, 404, { error: "missing" });
    const [startText, endText] = String(body.timeperiods?.[0] ?? "").split("/");
    const start = Date.parse(startText);
    const end = Date.parse(endText);
    const events = state.events[bucketId].filter((event) => {
      const eventStart = Date.parse(event.timestamp);
      const eventEnd = eventStart + Number(event.duration) * 1000;
      return eventEnd > start && eventStart < end;
    });
    return send(res, 200, [events]);
  }
  const setting = path.match(/^\/api\/0\/settings\/([^/]+)$/);
  if (setting && req.method === "GET") {
    const key = decodeURIComponent(setting[1]);
    const fault = state.faults.secondRead;
    if (fault?.key === key) {
      fault.reads += 1;
      if (fault.reads >= 2) state.settings[key] = fault.replace;
    }
    return send(res, 200, Object.hasOwn(state.settings, key) ? state.settings[key] : null);
  }
  if (setting && req.method === "POST") {
    const key = decodeURIComponent(setting[1]);
    state.settingsPosts += 1;
    state.settings[key] = body;
    if (state.faults.replaceAfterWrite?.key === key) {
      state.settings[key] = state.faults.replaceAfterWrite.replace;
      state.faults.replaceAfterWrite = null;
    }
    return send(res, 201, null, true);
  }
  return send(res, 404, { error: "not found" });
}

function applyEvents(state, bucketId, events) {
  const saved = [];
  for (const event of events ?? []) {
    if (event.id !== undefined) {
      const existing = state.events[bucketId].find((item) => item.id === event.id);
      if (!existing) {
        const error = new Error("missing event");
        error.status = 404;
        throw error;
      }
      Object.assign(existing, event);
      saved.push({ ...existing });
      continue;
    }
    const stored = { ...event, id: state.nextId };
    state.nextId += 1;
    state.events[bucketId].push(stored);
    saved.push({ ...stored });
  }
  return saved;
}

function redirect(req, res, location) {
  const target = /^https?:\/\//.test(location) ? location : `http://${req.headers.host}${location}`;
  res.statusCode = 308;
  res.setHeader("location", target);
  res.end();
}

function send(res, status, value, empty = false) {
  res.statusCode = status;
  if (empty) {
    res.end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}
