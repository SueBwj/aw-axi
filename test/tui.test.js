import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./synthetic-server.js";
import { activityUnions, clipDisplay, displayWidth, padDisplay, partitionAfk, reduceDomain, sanitizeTerminal, windowKey } from "../src/tui-data.js";
import { frameDashboard, paintDashboard, renderDashboard } from "../src/tui-render.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(root, "bin", "aw-axi.js");
const now = "2026-11-16T02:42:00.000Z";

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: {
        ...process.env,
        AWAXI_BASE_URL: "",
        AWAXI_STATE: "",
        AWAXI_NOW: "",
        AWAXI_REFUSE_5600: "1",
        NO_COLOR: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function at(ms, seconds, data) {
  return { timestamp: new Date(ms).toISOString(), duration: seconds, data };
}

test("AFK overlap stays unknown instead of picking either status", () => {
  const part = partitionAfk(0, 10_000, [
    at(0, 10, { status: "afk" }),
    at(5_000, 10, { status: "not-afk" }),
  ]);
  assert.equal(part.afk, 5_000);
  assert.equal(part.notAfk, 0);
  assert.equal(part.overlap, 5_000);
  assert.equal(part.complete, false);
  const same = partitionAfk(0, 10_000, [at(0, 10, { status: "afk" }), at(0, 5, { status: "afk" })]);
  assert.equal(same.afk, 5_000);
  assert.equal(same.overlap, 5_000);
});

test("an unrecognized AFK status is not counted as afk or idle", () => {
  const part = partitionAfk(0, 10_000, [at(0, 5, { status: "away" })]);
  assert.equal(part.unrecognized, 5_000);
  assert.equal(part.afk, 0);
  assert.equal(part.notAfk, 0);
  assert.equal(part.missing, 5_000);
  assert.equal(part.complete, false);
});

test("overlapping apps keep their own unions and do not invent a lexical winner", () => {
  const result = activityUnions(0, 10_000, [
    at(0, 10, { app: "Beta" }),
    at(0, 10, { app: "Alpha" }),
  ], windowKey);
  assert.equal(result.union, 10_000);
  assert.equal(result.rowsOverlap, true);
  assert.deepEqual(result.rows.map((row) => row.key).sort(), ["Alpha", "Beta"]);
  assert.equal(result.rows.every((row) => row.ms === 10_000), true);
});

test("domains drop credentials, paths, and queries, and control characters do not remain", () => {
  assert.equal(reduceDomain("https://user:pass@www.docs.example.test/secret-path?q=CANARY_QUERY"), "docs.example.test");
  assert.equal(reduceDomain("not a url"), null);
  assert.equal(sanitizeTerminal("\u001b]0;secret\u0007Editor"), "Editor");
  assert.equal(sanitizeTerminal("\u001b[31mName\u001b[0m"), "Name");
  assert.equal(sanitizeTerminal("\u009d0;hidden\u009c\u009b31mNa\u0085me\u009b0m"), "Name");
  assert.equal(sanitizeTerminal("\u001b]0;hidden\u009c\u009d0;hidden\u001b\\Name\u009f"), "Name");
  assert.equal(sanitizeTerminal("Visible" + "\u009d\u001b]".repeat(4000) + "unfinished"), "Visible");
  assert.equal(displayWidth("代码编辑器"), 10);
});

test("flag and keycap graphemes occupy two terminal cells when measured, clipped, and padded", () => {
  for (const emoji of ["🇹🇼", "1️⃣", "#️⃣", "*\u20E3"]) {
    assert.equal(displayWidth(emoji), 2, emoji);
    assert.equal(displayWidth(`a${emoji}b`), 4, emoji);
    assert.equal(clipDisplay(`a${emoji}b`, 3), "a…", emoji);
    assert.equal(padDisplay(emoji, 3, "start"), `${emoji} `, emoji);
  }
  assert.equal(displayWidth("1#*"), 3);
});

test("rows keep their display columns and stay inside the terminal width", () => {
  const model = {
    ok: true,
    anchor: "2026-11-16 10:42",
    timeZone: "Asia/Shanghai",
    mode: "today",
    host: "fixture-a",
    elapsed: 10 * 3_600_000 + 42 * 60_000,
    apps: {
      absent: false,
      truncated: false,
      invalid: 0,
      rowsOverlap: false,
      union: 3_600_000,
      rows: [
        { key: "代码编辑器", ms: 3_600_000 },
        { key: "笔记📝", ms: 1_200_000 },
      ],
    },
    web: {
      absent: false,
      truncated: false,
      invalid: 0,
      rowsOverlap: false,
      union: 1_200_000,
      rows: [{ key: "docs.example.test", ms: 1_200_000 }],
    },
    afk: { absent: true },
    timers: {
      state: "ready",
      rows: [{ label: "reading", running: 18 * 60_000, stored: 0 }],
      invalid: 0,
      reason: "Manual timer totals are not added to foreground time.",
    },
    categories: { reason: "No complete native rule set. Defaults were not created." },
    uncategorized: {
      reason: "AFK coverage is missing, overlapping, truncated, or unrecognized. No status was chosen by sort order.",
    },
  };
  for (const columns of [48, 100]) {
    const text = renderDashboard(model, { columns });
    const lines = text.split("\n");
    for (const line of lines) assert.ok(displayWidth(line) <= columns, `${columns} ${displayWidth(line)} ${line}`);
    const bars = lines.filter((line) => line.includes("━")).map((line) => displayWidth(line.slice(0, line.indexOf("━"))));
    assert.ok(bars.length >= 2);
    assert.equal(new Set(bars).size, 1, bars.join(","));
    assert.ok(!lines.some((line) => line.replaceAll("│", "").trim() === "not"));
  }
  assert.match(renderDashboard(model, { columns: 100 }), /q quit/);
  const hint = renderDashboard(model, { columns: 48 }).split("\n").at(-1);
  assert.match(hint, /…$/);
  assert.doesNotMatch(hint, /q quit/);
  assert.doesNotMatch(hint, /r r…/);
  for (const compact of [model, { ok: false, message: "The server could not be read." }]) {
    for (const columns of [1, 4, 16]) {
      const text = renderDashboard(compact, { columns });
      assert.ok(text.split("\n").every(line => displayWidth(line) <= columns));
      for (const rows of [1, 2, 3]) {
        const frame = frameDashboard(text, { columns, rows, scroll: 5 }).text.split("\n");
        assert.equal(frame.length, rows);
        assert.equal(frame.at(-1), text.split("\n").at(-1));
        assert.ok(frame.every(line => displayWidth(line) <= columns));
      }
    }
  }
});

test("a failed frame does not keep a previous total, and color does not paint a background", () => {
  const failed = renderDashboard({ ok: false, message: "Could not read 127.0.0.1:9", detail: ["Pass --host."] }, { columns: 40 });
  assert.match(failed, /Could not read 127\.0\.0\.1:9/);
  assert.match(failed, /No activity totals are shown/);
  assert.doesNotMatch(failed, /foreground union/);
  const errorFrame = frameDashboard(failed, { rows: 12 }).text.split("\n");
  assert.equal(errorFrame.length, 12);
  assert.ok(errorFrame.every(line => displayWidth(line) <= 40), errorFrame.join("\n"));
  const painted = paintDashboard("AFK missing  6m  unknown\nnot added to foreground\n━━━━╌", true);
  assert.match(painted, /38;5;179/);
  assert.doesNotMatch(painted, /48;/);
  assert.equal(paintDashboard(painted, false), painted);
  const framed = frameDashboard(`${"row\n".repeat(10)}hint`, { rows: 6, scroll: 3 });
  assert.match(framed.text, /↓ /);
  assert.match(framed.text, /hint/);
});

test("the dashboard refuses another command, another output mode, and port 5600", async () => {
  const command = await run(["timer", "status", "--tui", "--base-url", "http://127.0.0.1:9"]);
  assert.equal(command.code, 2);
  assert.match(command.stdout, /cannot be combined with command `timer`/);
  const output = await run(["--tui", "--json", "--base-url", "http://127.0.0.1:9"]);
  assert.equal(output.code, 2);
  assert.match(output.stdout, /output flag `--json`/);
  const refused = await run(["--tui", "--once", "--base-url", "http://127.0.0.1:5600"]);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout, /Refusing port 5600/);
  const help = await run(["--tui", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /aw-axi --tui --base-url <url>/);
  assert.doesNotMatch(help.stdout, /\bawaxi\b/);
  assert.match(help.stdout, /does not write to the server/);
  const missing = await run(["--tui", "--bucket", "--once", "--host", "fixture-a"]);
  assert.equal(missing.code, 2);
  assert.match(missing.stdout, /--bucket requires a value/);
});

test("dashboard operands retain their roles and distinct activity identities", async t => {
  const server = await startServer();
  t.after(() => server.close());
  const { state } = server;
  seed(state);
  for (const bucket of Object.values(state.buckets)) bucket.hostname = "timer";
  const window = state.events["aw-watcher-window_fixture-a"];
  window.push({ ...window[0], data: { app: "\u001b[31mEditor\u001b[0m" } });
  const timer = state.events["aw-stopwatch_fixture-a"][0];
  state.buckets["-h"] = { id: "-h", type: "general.stopwatch" };
  state.events["-h"] = [timer, { ...timer, id: state.nextId++, data: { label: " reading", running: true } }];
  const args = ["--tui", "--once", "--base-url", server.baseUrl, "--now", now,
    "--timezone", "UTC", "--host", "timer", "--bucket", "-h"];
  const result = await run(args);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /host timer/);
  assert.equal([...result.stdout.matchAll(/Editor\s+━/g)].length, 2);
  assert.equal([...result.stdout.matchAll(/reading\s+running/g)].length, 2);
  assert.doesNotMatch(result.stdout, /\u001b/);
  assert.equal(state.requests.filter(request => request.path === "/api/0/buckets/").length, 1);
});

test("one-shot TTY output retains the whole report and its error diagnostic", async t => {
  const server = await startServer();
  t.after(() => server.close());
  seed(server.state);
  const args = ["--tui", "--once", "--base-url", server.baseUrl, "--timezone", "UTC"];
  const size = { rows: 3, columns: 40 };
  const narrow = await pty([...args, "--now", now], null, size);
  assert.equal(narrow.code, 0, narrow.stdout);
  const lines = narrow.stdout.replaceAll("\r", "").trimEnd().split("\n");
  assert.ok(lines.length > size.rows);
  assert.match(narrow.stdout, /Web tabs/);
  assert.match(narrow.stdout, /Uncategorized/);
  assert.ok(lines.every(line => displayWidth(line) <= size.columns), narrow.stdout);
  const failure = await pty([...args, "--now", "invalid"], null, size);
  assert.notEqual(failure.code, 0, failure.stdout);
  assert.match(failure.stdout.replace(/\s+/g, " "), /valid ISO 8601 date-time/);
  assert.match(failure.stdout, /No activity totals are shown/);
});

test("dashboard checks category compatibility before presenting rules as available", async t => {
  const server = await startServer();
  t.after(() => server.close());
  seed(server.state);
  const { state } = server;
  state.buckets.afk = { id: "afk", type: "afkstatus", hostname: "fixture-a" };
  state.events.afk = [at(Date.parse("2026-11-16T00:00:00Z"), 3 * 3600, { status: "not-afk" })];
  const category = { name: ["Work"], rule: { type: "none" } };
  state.settings = { category_sets: [{ id: "main", categories: [category] }], active_set_ids: ["main"], classes: [] };
  const args = ["--tui", "--once", "--base-url", server.baseUrl, "--now", now, "--timezone", "UTC"];
  const incomplete = await run(args);
  assert.equal(incomplete.code, 0, incomplete.stdout);
  assert.match(incomplete.stdout, /No complete native rule set\./);
  assert.match(incomplete.stdout, /No complete native rule set is applied here/);
  state.settings.classes = [category];
  const complete = await run(args);
  assert.equal(complete.code, 0, complete.stdout);
  assert.match(complete.stdout, /A native rule set is present/);
  assert.match(complete.stdout, /Uncategorized stays withheld/);
});

test("one frame shows separate measures and does not write", async () => {
  const server = await startServer();
  try {
    seed(server.state);
    const host = "\u009d0;CANARY_CONTROL\u009cfixture-a";
    for (const bucket of Object.values(server.state.buckets)) bucket.hostname = host;
    server.state.events["aw-watcher-window_fixture-a"][0].data.app = "Edi\u0085tor";
    server.state.events["aw-stopwatch_fixture-a"][0].data.label = "\u009b31mreading\u009b0m";
    const result = await run([
      "--tui",
      "--once",
      "--base-url",
      server.baseUrl,
      "--now",
      now,
      "--timezone",
      "Asia/Shanghai",
      "--host",
      host,
    ], { COLUMNS: "100" });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /2026-11-16 10:42/);
    assert.match(result.stdout, /host fixture-a/);
    assert.match(result.stdout, /foreground union\s+1h/);
    assert.match(result.stdout, /no window event\s+9h 42m\s+unknown/);
    assert.match(result.stdout, /Editor/);
    assert.match(result.stdout, /docs\.example\.test/);
    assert.match(result.stdout, /observed tab time, not foreground browser use/);
    assert.match(result.stdout, /reading\s+running 18m/);
    assert.match(result.stdout, /not added to foreground/);
    assert.match(result.stdout, /not-afk with windows\s+withheld/);
    assert.match(result.stdout, /No complete native rule set/);
    assert.doesNotMatch(result.stdout, /CANARY|secret-path|user:pass|1h 18m|[\u007f-\u009f]/);
    const writes = server.state.requests.filter((request) => request.method !== "GET" && request.path !== "/api/0/query/");
    assert.deepEqual(writes, []);
  } finally {
    await server.close();
  }
});

test("ambiguous hosts are named and not totaled", async () => {
  const server = await startServer();
  try {
    seed(server.state);
    server.state.buckets["aw-watcher-window_fixture-b"] = {
      id: "aw-watcher-window_fixture-b",
      type: "currentwindow",
      hostname: "fixture-b",
    };
    server.state.events["aw-watcher-window_fixture-b"] = [];
    const result = await run(["--tui", "--once", "--base-url", server.baseUrl, "--now", now, "--timezone", "Asia/Shanghai"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /Pass --host/);
    assert.match(result.stdout, /No activity totals are shown/);
    assert.doesNotMatch(result.stdout, /Editor|docs\.example\.test|18m/);
  } finally {
    await server.close();
  }
});

test("a closed server stays visible and an explicit range drops the day keys", async () => {
  const server = await startServer();
  const baseUrl = server.baseUrl;
  await server.close();
  const closed = await run(["--tui", "--once", "--base-url", baseUrl, "--now", now]);
  assert.notEqual(closed.code, 0);
  assert.match(closed.stdout, /No activity totals are shown/);
  const live = await startServer();
  try {
    seed(live.state);
    const ranged = await run([
      "--tui",
      "--once",
      "--base-url",
      live.baseUrl,
      "--now",
      now,
      "--timezone",
      "Asia/Shanghai",
      "--host",
      "fixture-a",
      "--start",
      "2026-11-16T09:00:00",
      "--end",
      "2026-11-16T10:00:00",
    ]);
    assert.equal(ranged.code, 0, ranged.stdout);
    assert.match(ranged.stdout, /explicit range/);
    assert.doesNotMatch(ranged.stdout, /t today/);
    assert.match(ranged.stdout, /foreground union\s+1h/);
  } finally {
    await live.close();
  }
});

test("q and Ctrl-C leave a real terminal session", async () => {
  const server = await startServer();
  try {
    seed(server.state);
    const quit = await pty([
      "--tui",
      "--base-url",
      server.baseUrl,
      "--now",
      now,
      "--timezone",
      "Asia/Shanghai",
      "--host",
      "fixture-a",
    ], "q");
    assert.equal(quit.code, 0, quit.stdout);
    assert.match(quit.stdout, /foreground union/);
    assert.match(quit.stdout, /\u001b\[\?1049h/);
    assert.match(quit.stdout, /\u001b\[\?1049l/);
    const interrupt = await pty([
      "--tui",
      "--base-url",
      server.baseUrl,
      "--now",
      now,
      "--timezone",
      "Asia/Shanghai",
      "--host",
      "fixture-a",
    ], "\u0003");
    assert.equal(interrupt.code, 0, interrupt.stdout);
    assert.match(interrupt.stdout, /\u001b\[\?1049l/);
  } finally {
    await server.close();
  }
});

test("quitting the dashboard aborts an in-flight read before any follow-up", { timeout: 5000 }, async t => {
  const requested = Promise.withResolvers();
  const canceled = Promise.withResolvers();
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    requested.resolve();
    res.on("close", () => canceled.resolve(!res.writableEnded));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const { port } = server.address();
  assert.notEqual(port, 5600);
  const script = `
    import { runTui } from './src/tui.js';
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true });
    process.stdin.setRawMode = () => {};
    process.once('message', () => process.stdin.emit('data', Buffer.from('q')));
    await runTui(['--base-url', 'http://127.0.0.1:${port}']);
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, stdio: ["pipe", "pipe", "inherit", "ipc"], env: { ...process.env, AWAXI_NOW: "", AWAXI_REFUSE_5600: "1" },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exited = new Promise(resolve => child.once("close", resolve));
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  await requested.promise;
  child.send("quit");
  assert.equal(await exited, 0, output);
  assert.equal(await canceled.promise, true);
  assert.match(output, /\u001b\[\?1049l/);
  assert.deepEqual(requests, ["/api/0/buckets/"]);
});

function seed(state) {
  const windowId = "aw-watcher-window_fixture-a";
  const webId = "aw-watcher-web_fixture-a";
  const watchId = "aw-stopwatch_fixture-a";
  state.buckets[windowId] = { id: windowId, type: "currentwindow", hostname: "fixture-a" };
  state.buckets[webId] = { id: webId, type: "web.tab.current", hostname: "fixture-a" };
  state.buckets[watchId] = { id: watchId, type: "general.stopwatch", hostname: "fixture-a" };
  state.events[windowId] = [{
    id: state.nextId++,
    timestamp: "2026-11-16T01:00:00.000Z",
    duration: 3600,
    data: { app: "Editor", title: "CANARY_TITLE_SECRET" },
  }];
  state.events[webId] = [{
    id: state.nextId++,
    timestamp: "2026-11-16T01:00:00.000Z",
    duration: 1200,
    data: { url: "https://user:pass@docs.example.test/secret-path?q=CANARY_QUERY", title: "CANARY_TITLE_SECRET" },
  }];
  state.events[watchId] = [{
    id: state.nextId++,
    timestamp: "2026-11-16T02:24:00.000Z",
    duration: 0,
    data: { label: "reading", running: true },
  }];
}

function pty(args, key, { rows = 40, columns = 120 } = {}) {
  const script = `
import fcntl, os, pty, select, struct, sys, termios, time
node, program, *args = sys.argv[1:]
key = os.environ["TUI_KEY"].encode()
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack('HHHH', ${rows}, ${columns}, 0, 0))
    os.execv(node, [node, program, *args])
buf = b""
sent = False
deadline = time.time() + 8
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if fd not in ready:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    buf += chunk
    if key and not sent and (b"Coverage" in buf or b"aw-axi --tui" in buf):
        os.write(fd, key)
        sent = True
os.close(fd)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(buf)
raise SystemExit(0 if (not key or sent) and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else 1)
`;
  return new Promise((resolve) => {
    const child = spawn("python3", ["-c", script, process.execPath, bin, ...args], {
      env: { ...process.env, AWAXI_REFUSE_5600: "1", NO_COLOR: "1", TUI_KEY: key ?? "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout: stdout + stderr }));
  });
}
