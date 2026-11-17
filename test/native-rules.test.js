import nodeTest from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createClient } from "../src/client.js";
import { nativeShow, nativePreview, nativeApply, NATIVE_FORMAT } from "../src/native-rules.js";
import { revisionOf } from "../src/revision.js";

const evidence = process.env.AWAXI_TEST_DATA || path.join(process.env.TMPDIR || "/tmp", "aw-axi-tests");
const bundlePath = process.env.AWAXI_TEST_WEBUI_BUNDLE;
const bundle = bundlePath ? await readFile(bundlePath, "utf8") : null;
const test = bundle ? nodeTest : nodeTest.skip;
const cat = (name, regex, extra = {}) => ({ name: [name], rule: { type: "regex", regex, ...extra }, future: { keep: true } });
function taxonomy() {
  const primary = cat("Same", "Primary", { priority: 70, select_keys: ["app"], ignore_case: true });
  const secondary = cat("Other", "Other");
  return {
    category_sets: [
      { id: "default", categories: [primary], tombstones: ['["Hidden"]'], extension: { keep: 1 } },
      { id: "lower", categories: [cat("Same", "Masked"), cat("Hidden", "Hidden"), secondary] },
      { id: "disabled", categories: [cat("Disabled", "Disabled")] },
    ],
    active_set_ids: ["default", "lower"],
    classes: [primary, secondary],
  };
}

async function fixture(version = "v0.14.2 (rust)", initial = {}) {
  await mkdir(evidence, { recursive: true });
  const dir = await mkdtemp(path.join(evidence, "native-faults-"));
  const state = { settings: structuredClone(initial), version, posts: [], reads: 0, hook: null, dropAt: 0, badBundle: false };
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const send = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.url === "/api/0/info") return send({ version: state.version });
    if (req.url === "/") return res.end('<script src="/js/index.15e65e70.js"></script>');
    if (req.url === "/js/index.15e65e70.js") return res.end(state.badBundle ? "wrong" : bundle);
    if (req.method === "GET" && req.url === (version.endsWith("(rust)") ? "/api/0/settings/" : "/api/0/settings")) {
      state.reads++;
      state.hook?.(state);
      return send(state.settings);
    }
    if (["POST", "DELETE"].includes(req.method) && req.url.startsWith("/api/0/settings/")) {
      const key = req.url.split("/").at(-1);
      const value = text ? JSON.parse(text) : undefined;
      state.posts.push({ method: req.method, key, value });
      if (req.method === "DELETE" || (version === "v0.14.2" && (value === null || value === false || (Array.isArray(value) && !value.length)))) delete state.settings[key];
      else state.settings[key] = value;
      if (state.posts.length === state.dropAt) return req.socket.destroy();
      if (state.dropBodyAt === state.posts.length) {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100" });
        res.write("{");
        setImmediate(() => res.destroy());
        return;
      }
      return send(null);
    }
    res.statusCode = 404; send({ error: "unexpected canonical route" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(server.address().port, 5600);
  const client = createClient(base);
  const shown = await nativeShow({}, client);
  const file = path.join(dir, "document.json");
  const doc = { format: NATIVE_FORMAT, coverage: "complete", target: shown.target, settings: taxonomy() };
  await writeFile(file, JSON.stringify(doc));
  let sequence = 0;
  const flags = (extra = {}) => ({ server: true, "base-url": base, state: path.join(dir, "state"), file: extra["save-backup"] ? undefined : file, expect: revisionOf(state.settings), backup: path.join(dir, `backup-${++sequence}.json`), ...extra });
  return { state, dir, client, doc, file, flags, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

for (const version of ["v0.14.2", "v0.14.2 (rust)"]) {
  test(`${version}: explicit initialization, complete preview, idempotency, private backup and exact absence restore`, async () => {
    const f = await fixture(version, { unrelated: { future: [1, 2] } });
    try {
      await assert.rejects(nativeApply(f.flags(), f.client), { code: "UNSUPPORTED" });
      assert.equal(f.state.posts.length, 0);
      const preview = await nativePreview({ file: f.file });
      assert.deepEqual(preview.active_set_ids, ["default", "lower"]);
      const args = f.flags({ initialize: true });
      const result = await nativeApply(args, f.client);
      assert.equal(result.result, "persisted");
      assert.equal((await stat(args.backup)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(args.backup, "utf8")).settings, {});
      assert.deepEqual(f.state.settings, { unrelated: { future: [1, 2] }, ...taxonomy() });
      assert.equal(f.state.posts.length, 3);
      assert.equal((await nativeApply(f.flags(), f.client)).result, "no-op");
      assert.equal(f.state.posts.length, 3);
      const restored = await nativeApply(f.flags({ backup: args.backup, "save-backup": path.join(f.dir, "before-restore.json") }), f.client, true);
      assert.equal(restored.result, "restored");
      assert.deepEqual(f.state.settings, { unrelated: { future: [1, 2] } });
      assert.equal((await stat(path.join(f.dir, "before-restore.json"))).mode & 0o777, 0o600);
    } finally { await f.close(); }
  });
}

test("Rust restores explicit null separately from absence; Python refuses unroundtrippable null", async () => {
  for (const version of ["v0.14.2", "v0.14.2 (rust)"]) {
    const f = await fixture(version, { classes: null, unrelated: 42 });
    try {
      const args = f.flags({ initialize: true });
      if (version === "v0.14.2") {
        await assert.rejects(nativeApply(args, f.client), { code: "UNSUPPORTED" });
        assert.equal(f.state.posts.length, 0);
      } else {
        await nativeApply(args, f.client);
        await nativeApply(f.flags({ backup: args.backup, "save-backup": path.join(f.dir, "reverse.json") }), f.client, true);
      }
      assert.deepEqual(f.state.settings, { classes: null, unrelated: 42 });
    } finally { await f.close(); }
  }
});

test("unknown schemas/builds/targets, inconsistent compatibility list and incomplete initialization refuse before mutation", async () => {
  const f = await fixture();
  try {
    f.state.version = "v0.15.0";
    await assert.rejects(nativeApply(f.flags({ initialize: true }), f.client), { code: "UNSUPPORTED" });
    f.state.version = "v0.14.2 (rust)";
    f.state.badBundle = true;
    await assert.rejects(nativeApply(f.flags({ initialize: true }), f.client), { code: "UNSUPPORTED" });
    f.state.badBundle = false;
    const original = structuredClone(f.doc);
    for (const change of [d => d.settings.active_set_ids.push("missing"), d => d.settings.classes.pop(), d => d.settings.category_sets[0].categories[0].rule.type = "future", d => d.coverage = "partial"]) {
      const doc = structuredClone(original); change(doc); await writeFile(f.file, JSON.stringify(doc));
      await assert.rejects(nativeApply(f.flags({ initialize: true }), f.client), { code: "VALIDATION_ERROR" });
    }
    await writeFile(f.file, JSON.stringify({ ...original, target: { ...original.target, base_url: "http://127.0.0.1:9" } }));
    await assert.rejects(nativeApply(f.flags({ initialize: true }), f.client), { code: "CONFLICT" });
    await writeFile(f.file, JSON.stringify(original));
    f.state.settings.category_sets = { futureSchema: true };
    await assert.rejects(nativeApply(f.flags({ initialize: true }), f.client), { code: "UNSUPPORTED" });
    assert.equal(f.state.posts.length, 0);
  } finally { await f.close(); }
});

test("unknown concurrent edits before and between writes are never overwritten", async () => {
  for (const afterWrites of [0, 1, 2]) {
    const f = await fixture();
    try {
      let injected = false;
      f.state.hook = state => {
        if (!injected && state.posts.length === afterWrites && state.reads >= 3) { state.settings.otherWriter = { keep: "new" }; injected = true; }
      };
      await assert.rejects(nativeApply(f.flags({ initialize: true }), f.client), { code: afterWrites ? "UNCERTAIN_WRITE" : "CONFLICT" });
      assert.equal(f.state.posts.length, afterWrites);
      assert.deepEqual(f.state.settings.otherWriter, { keep: "new" });
    } finally { await f.close(); }
  }
});

test("dropped responses at each native write stop without retries; explicit restore preserves other settings", async () => {
  for (const dropAt of [1, 2, 3]) {
    const f = await fixture("v0.14.2 (rust)", { unrelated: "untouched" });
    try {
      f.state.dropAt = dropAt;
      const args = f.flags({ initialize: true });
      await assert.rejects(nativeApply(args, f.client), { code: "UNCERTAIN_WRITE" });
      assert.equal(f.state.posts.length, dropAt);
      f.state.dropAt = 0;
      await nativeApply(f.flags({ backup: args.backup, "save-backup": path.join(f.dir, "partial.json") }), f.client, true);
      assert.deepEqual(f.state.settings, { unrelated: "untouched" });
    } finally { await f.close(); }
  }
});

test("a backup made during recovery can restore the exact partial state", async () => {
  const f = await fixture();
  try {
    f.state.dropAt = 1;
    const args = f.flags({ initialize: true });
    await assert.rejects(nativeApply(args, f.client), { code: "UNCERTAIN_WRITE" });
    const partial = structuredClone(f.state.settings);
    const savedPartial = path.join(f.dir, "partial.json");
    f.state.dropAt = 0;
    await nativeApply(f.flags({ backup: args.backup, "save-backup": savedPartial }), f.client, true);
    assert.deepEqual(f.state.settings, {});
    await nativeApply(f.flags({ backup: savedPartial, "save-backup": path.join(f.dir, "empty.json") }), f.client, true);
    assert.deepEqual(f.state.settings, partial);
  } finally { await f.close(); }
});


test("a truncated write response body is uncertain and never retried", async () => {
  const f = await fixture();
  try {
    f.state.dropBodyAt = 1;
    await assert.rejects(nativeApply(f.flags({ initialize: true }), f.client), { code: "UNCERTAIN_WRITE" });
    assert.equal(f.state.posts.length, 1);
  } finally { await f.close(); }
});

test("native input reads enforce the size limit before mutation", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, " ".repeat(8 * 1024 * 1024 + 1));
    await assert.rejects(nativeApply(f.flags({ initialize: true }), f.client), /8 MiB/);
    assert.equal(f.state.posts.length, 0);
  } finally { await f.close(); }
});
