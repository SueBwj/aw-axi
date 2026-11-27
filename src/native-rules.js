import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { AxiError } from "axi-sdk-js";
import { MAX_RESPONSE_BYTES } from "./client.js";
import { decimalParts, sameDecimal } from "./json-numbers.js";
import { withLock } from "./lock.js";
import { absolutePath, stateDirFrom } from "./options.js";
import { revisionOf, stableStringify } from "./revision.js";

export const NATIVE_FORMAT = "activitywatch-axi.native-rules.v1";
const BACKUP_FORMAT = "activitywatch-axi.native-rules-backup.v1";
export const NATIVE_KEYS = ["category_sets", "active_set_ids", "classes"];
const DOCUMENT_LIMIT = 8 * 1024 * 1024;
// Released v0.14.2 webUI, aw-webui 42fe89f07914b8190dc2f0cb59e0df1a976a1261.
// Pin the served bundle, not just the backend version: they can be upgraded independently.
const BUNDLE = "/js/index.15e65e70.js";
const BUNDLE_HASH = "ecbfd637750abb8f7da32dbc32a8f6d41ba167f28dfb8ec0512e304429a94a40";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const equal = (a, b) => stableStringify(a) === stableStringify(b);
const fail = (message, code = "VALIDATION_ERROR") => { throw new AxiError(message, code); };
const subset = (settings) => Object.fromEntries(NATIVE_KEYS.filter(k => Object.hasOwn(settings, k)).map(k => [k, settings[k]]));

async function capability(client) {
  const url = new URL(client.baseUrl);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    fail("Native rules require an explicit HTTP loopback target.");
  }
  const info = await client.request("GET", "/api/0/info");
  if (!["v0.14.2", "v0.14.2 (rust)"].includes(info?.version)) {
    fail("Native rules support only the verified v0.14.2 Python/Rust release.", "UNSUPPORTED");
  }
  const html = await client.request("GET", "/", { raw: true });
  if (typeof html !== "string" || !html.includes(BUNDLE)) {
    fail("The served webUI build is not supported. No settings were written.", "UNSUPPORTED");
  }
  const bundle = await client.request("GET", BUNDLE, { raw: true });
  if (createHash("sha256").update(bundle).digest("hex") !== BUNDLE_HASH) {
    fail("The served webUI bundle does not match the verified release.", "UNSUPPORTED");
  }
  return { base_url: client.baseUrl, server_version: info.version, webui_sha256: BUNDLE_HASH };
}

function rustDecimalMatches({ digits, exponent }, number) {
  if (Math.abs(exponent) > 22 || digits.length > 20 ||
      (digits.length === 20 && BigInt(digits) >= (1n << 64n))) return false;
  const significand = Number(digits);
  const scale = Number("1e" + Math.abs(exponent));
  const parsed = exponent < 0 ? significand / scale : significand * scale;
  return parsed === Math.abs(number);
}

function rustLongIntegerMatches(source, number) {
  const magnitude = source.startsWith("-") ? source.slice(1) : source;
  const prefix = magnitude.slice(0, 20);
  const digits = BigInt(prefix) < (1n << 64n) ? prefix : prefix.slice(0, 19);
  return rustDecimalMatches({ digits, exponent: magnitude.length - digits.length }, number);
}

function parseNativeJson(text, message, code, target) {
  try {
    const mayUseRust = !target || target.server_version === "v0.14.2 (rust)";
    const unverifiedRustChildren = new WeakSet();
    const unverifiedRustRuleChildren = new WeakSet();
    const markUnverified = (holder, key) => {
      unverifiedRustChildren.add(holder);
      if (NATIVE_KEYS.includes(key)) unverifiedRustRuleChildren.add(holder);
    };
    const parsed = JSON.parse(text, function (key, value, context) {
      if (typeof value !== "number") {
        if (unverifiedRustChildren.has(value)) markUnverified(this, key);
        return value;
      }
      if (Number.isFinite(value)) {
        const source = context.source;
        const encoded = JSON.stringify(value);
        const sourceIsInteger = !/[.eE]/.test(source);
        const encodedIsInteger = !/[.e]/.test(encoded);
        if (mayUseRust && (!sourceIsInteger || !encodedIsInteger)) {
          const sourceMatches = sourceIsInteger
            ? rustLongIntegerMatches(source, value)
            : rustDecimalMatches(decimalParts(source, { trimTrailingZeros: false }), value);
          const unverified = !sourceMatches ||
            (encoded !== source && !encodedIsInteger &&
              !rustDecimalMatches(decimalParts(encoded, { trimTrailingZeros: false }), value));
          if (unverified) markUnverified(this, key);
        }
        if (encoded === source) return value;
        if (sourceIsInteger) {
          if (!encodedIsInteger && BigInt(source) === BigInt(value)) return value;
        } else if (sameDecimal(source, encoded) &&
            (!encodedIsInteger || BigInt(encoded) === BigInt(value))) return value;
      }
      fail("A native JSON number cannot be represented without rounding.", "UNSUPPORTED");
    });
    const unverified = target ? unverifiedRustRuleChildren : unverifiedRustChildren;
    if (unverified.has(parsed) && (target ?? parsed?.target)?.server_version === "v0.14.2 (rust)") {
      fail("A native number cannot be verified on the supported Rust server.", "UNSUPPORTED");
    }
    return parsed;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail(message, code);
  }
}

async function readSettings(client, target, includeWire = false) {
  const endpoint = target.server_version.endsWith("(rust)") ? "/api/0/settings/" : "/api/0/settings";
  const reply = await client.request("GET", endpoint, { raw: true });
  const settings = parseNativeJson(reply, "ActivityWatch returned a response that was not JSON", "SERVER", target);
  if (!object(settings)) fail("The native settings response is not an object.", "UNSUPPORTED");
  return includeWire ? { settings, reply } : settings;
}

function nativeWireValue(value, python) {
  return JSON.parse(JSON.stringify(value), (_, number, context) => {
    if (typeof number !== "number" || Number.isSafeInteger(number)) return number;
    const source = context.source;
    if (!/[.e]/.test(source)) {
      if (!python) {
        const integer = BigInt(source);
        if (integer < -(1n << 63n) || integer >= (1n << 64n)) {
          fail("A native integer is outside the supported Rust range.", "UNSUPPORTED");
        }
      }
      return number;
    }
    const parts = decimalParts(source, { trimTrailingZeros: python });
    const { negative, digits, exponent } = parts;
    if (!python && !rustDecimalMatches(parts, number)) {
      fail("A native decimal cannot be verified on the supported Rust server.", "UNSUPPORTED");
    }
    const power = exponent + digits.length - 1;
    if (power >= 16 || power < (python ? -4 : -5)) {
      const fraction = digits.length === 1 ? "" : "." + digits.slice(1);
      const signedPower = python ? (power < 0 ? "-" : "+") + String(Math.abs(power)).padStart(2, "0") : power;
      return JSON.rawJSON((negative ? "-" : "") + digits[0] + fraction + "e" + signedPower);
    }
    return number;
  });
}

function backupBytes(settings, target) {
  return documentBytes({ format: BACKUP_FORMAT, target, revision: revisionOf(settings), settings });
}

function validateRustPayload(value, depth = 0) {
  if (typeof value === "string" && !value.isWellFormed()) {
    fail("A native Rust payload contains an unpaired surrogate.", "UNSUPPORTED");
  }
  if (value === null || typeof value !== "object") return;
  if (depth >= 127) fail("A native Rust payload exceeds the supported nesting depth.", "UNSUPPORTED");
  if (Array.isArray(value)) {
    for (const item of value) validateRustPayload(item, depth + 1);
  } else {
    for (const [key, item] of Object.entries(value)) {
      validateRustPayload(key);
      validateRustPayload(item, depth + 1);
    }
  }
}

function preflightNativeWrite(current, before, after, changes, target, reply, python) {
  if (!python) {
    for (const settings of [before, after]) {
      for (const value of Object.values(settings)) validateRustPayload(value);
    }
  }
  const backup = backupBytes(before, target);
  const pretty = python && (reply.startsWith("{\n") ||
    Object.keys(current).every(key => NATIVE_KEYS.includes(key) && !Object.hasOwn(after, key)));
  const wire = JSON.parse(reply, (_, value, context) =>
    typeof value === "number" ? JSON.rawJSON(context.source) : value);
  const states = [{ settings: before, wire }];
  const bytes = (value, indent) => python ? pythonResponseBytes(value, indent) : Buffer.byteLength(JSON.stringify(value));
  for (const key of changes) {
    const hadKey = Object.hasOwn(before, key);
    const hasKey = Object.hasOwn(after, key);
    const previous = hadKey ? nativeWireValue(before[key], python) : null;
    const next = hasKey ? nativeWireValue(after[key], python) : null;
    if (python && [previous, next].some(value => pythonResponseBytes(value, pretty ? 4 : 0, !pretty) > MAX_RESPONSE_BYTES)) {
      fail("A planned native settings response would exceed the 8 MiB response limit.", "UNSUPPORTED");
    }
    const previousWire = hadKey && bytes(previous, 0) > bytes(wire[key], 0) ? previous : wire[key];
    for (const state of states.slice()) {
      if (hadKey) state.wire[key] = previousWire;
      const projected = { settings: { ...state.settings }, wire: { ...state.wire } };
      if (hasKey) {
        projected.settings[key] = after[key];
        projected.wire[key] = next;
      } else {
        delete projected.settings[key];
        delete projected.wire[key];
      }
      states.push(projected);
    }
  }
  for (const state of states) {
    if (bytes(state.wire, pretty ? 2 : 0) > MAX_RESPONSE_BYTES) {
      fail("A planned native settings response would exceed the 8 MiB response limit.", "UNSUPPORTED");
    }
    if (state.settings !== before) backupBytes(state.settings, target);
  }
  return backup;
}

function pythonResponseBytes(value, indent, spaced = false) {
  const json = JSON.stringify(value, null, indent);
  let bytes = 1;
  let quoted = false;
  for (let index = 0; index < json.length; index += 1) {
    const unit = json.charCodeAt(index);
    bytes += unit >= 0x7f ? 6 : 1;
    if (!spaced) continue;
    if (quoted && json[index] === "\\") {
      index += 1;
      bytes += 1;
    } else if (json[index] === '"') quoted = !quoted;
    else if (!quoted && (json[index] === "," || json[index] === ":")) bytes += 1;
  }
  return bytes;
}

export async function nativeShow(flags, client) {
  const target = await capability(client);
  const all = await readSettings(client, target);
  const settings = subset(all);
  let coverage = "complete";
  try { validateSettings(settings); } catch { coverage = Object.keys(settings).length ? "incomplete" : "absent"; }
  const result = {
    target, revision: revisionOf(all), revision_scope: "all-server-settings",
    coverage, presence: Object.fromEntries(NATIVE_KEYS.map(k => [k, Object.hasOwn(settings, k)])),
    browser_local: "not-read; server values take priority, missing keys may use browser fallback or native defaults",
    ui_adoption: "not-verified; reload the intended native UI and verify classification",
  };
  if (flags.full) result.settings = settings;
  if (flags.file) {
    await privateFile(flags.file, documentBytes({ format: NATIVE_FORMAT, coverage, target, settings }));
    result.file = absolutePath(flags.file);
  }
  return result;
}

export async function nativePreview(flags) {
  const doc = await readDocument(flags.file);
  validateDocument(doc);
  return {
    file: absolutePath(flags.file), target: doc.target, coverage: doc.coverage,
    active_set_ids: doc.settings.active_set_ids,
    sets: doc.settings.category_sets.map(s => ({ id: s.id, active: doc.settings.active_set_ids.includes(s.id), categories: s.categories.length, tombstones: s.tombstones?.length ?? 0 })),
    ...(flags.full ? { settings: doc.settings } : {}),
    ...(doc.settings.category_sets.some(set => set.categories.some(category => category.rule.select_keys?.includes("url")))
      ? { desktop_activity_limit: "The pinned native desktop Activity query does not pass browser URL fields to its category events." }
      : {}),
    browser_local: "not-read", ui_adoption: "not-verified",
  };
}

export async function nativeApply(flags, client, restoring = false) {
  if (!flags.server || !flags["base-url"] || !flags.state) fail("Native writes require --server, --base-url, and --state explicitly.");
  if (restoring && flags.file) fail("Native restore uses --backup; --file belongs to legacy file restore.");
  if (!/^[a-f0-9]{64}$/.test(flags.expect ?? "")) fail("--expect must be the current all-server-settings revision.");
  const output = restoring ? flags["save-backup"] : flags.backup;
  if (!output) fail(restoring ? "--save-backup is required for a private backup before restore." : "--backup is required.");
  const backup = absolutePath(output);
  const doc = await readDocument(restoring ? flags.backup : flags.file);
  if (restoring) {
    if (!object(doc) || doc.format !== BACKUP_FORMAT || !object(doc.settings) || Object.keys(doc.settings).some(k => !NATIVE_KEYS.includes(k)) || doc.revision !== revisionOf(doc.settings)) {
      fail("Invalid native rules backup.");
    }
    validateBackupSettings(doc.settings);
  } else validateDocument(doc);
  return withLock(stateDirFrom(flags), "settings", async () => {
    const target = await capability(client);
    if (!equal(doc.target, target)) fail("The document target differs from this server/build. Nothing was written.", "CONFLICT");
    const { settings: current, reply } = await readSettings(client, target, true);
    if (revisionOf(current) !== flags.expect) fail("Server settings changed. Read the current revision before applying.", "CONFLICT");
    const before = subset(current);
    const after = doc.settings;
    if (!restoring) {
      try { validateSettings(before); } catch {
        if (!flags.initialize || Object.values(before).some(value => value !== null)) {
          fail("Native category settings are absent/incomplete or unsupported. Only absent/null settings can use --initialize with a complete document; defaults were not invented.", "UNSUPPORTED");
        }
      }
    }
    // Python's set_setting removes falsey values. Such stored values cannot be faithfully restored.
    const python = target.server_version === "v0.14.2";
    if (python) {
      for (const values of [before, after]) {
        for (const value of Object.values(values)) {
          if (value === null || value === false || value === 0 || value === "" || (Array.isArray(value) && value.length === 0) || (object(value) && Object.keys(value).length === 0)) {
            fail("Python v0.14.2 deletes falsey settings; this state cannot be faithfully written and restored.", "UNSUPPORTED");
          }
        }
      }
    }
    if (equal(before, after)) return { result: "no-op", revision: flags.expect, ui_adoption: "not-verified" };
    validateBackupSettings(before, "UNSUPPORTED");
    const changes = NATIVE_KEYS.filter(key => !equal(before[key], after[key]));
    const saved = preflightNativeWrite(current, before, after, changes, target, reply, python);
    if (!equal(current, await readSettings(client, target))) fail("Settings changed before backup. Nothing was written.", "CONFLICT");
    await privateFile(backup, saved);
    const expected = { ...current };
    const written = [];
    try {
      for (const key of changes) {
        if (!equal(expected, await readSettings(client, target))) fail("Settings changed between native writes.", written.length ? "UNCERTAIN_WRITE" : "CONFLICT");
        if (Object.hasOwn(after, key)) {
          await client.request("POST", `/api/0/settings/${key}`, { body: after[key], mutation: true });
          expected[key] = after[key];
        } else {
          await client.request(python ? "POST" : "DELETE", `/api/0/settings/${key}`, { mutation: true, ...(python ? { body: null } : {}) });
          delete expected[key];
        }
        written.push(key);
        if (!equal(expected, await readSettings(client, target))) fail("Native settings did not match after a write.", "UNCERTAIN_WRITE");
      }
    } catch (error) {
      throw new AxiError(`Native write stopped: ${error.message}. No retry or automatic rollback was attempted.`, written.length || error.code === "UNCERTAIN_WRITE" ? "UNCERTAIN_WRITE" : error.code || "SERVER", [`Private backup: ${backup}`, `Acknowledged write requests: ${written.join(", ") || "none"}; the interrupted operation may still have persisted.`, "Read the current revision, then explicitly restore after checking it."]);
    }
    return { result: restoring ? "restored" : "persisted", backup, revision: revisionOf(expected), changed_keys: written, server_transaction: "unsupported", browser_local: "not-read-or-modified", ui_adoption: "not-verified; reload the native UI and check a known activity" };
  });
}

function validateBackupSettings(settings, code) {
  // Interrupted multi-key writes can leave a partial snapshot. Restore its exact
  // presence/value shape, without pretending it was a complete effective taxonomy.
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) continue;
    if (!Array.isArray(value)) fail("Invalid native backup setting shape.", code);
    if (key === "active_set_ids" && value.some(id => typeof id !== "string" || !id)) fail("Invalid backup active IDs.", code);
    const categories = key === "classes" ? value : key === "category_sets" ? value.flatMap(set => {
      if (!object(set) || typeof set.id !== "string" || !Array.isArray(set.categories)) fail("Invalid backup category set.", code);
      return set.categories;
    }) : [];
    if (categories.some(category => !object(category) || !validName(category.name) || !object(category.rule))) fail("Invalid backup category.", code);
  }
}

function validateDocument(doc) {
  if (!object(doc) || doc.format !== NATIVE_FORMAT || doc.coverage !== "complete" || !object(doc.target)) fail("Supply a complete activitywatch-axi.native-rules.v1 document with an explicit target.");
  validateSettings(doc.settings);
}

export function validateSettings(settings) {
  if (!object(settings) || Object.keys(settings).length !== 3 || !NATIVE_KEYS.every(k => Object.hasOwn(settings, k))) fail("A complete document contains exactly category_sets, active_set_ids, and classes.");
  const merged = effectiveCategories(settings);
  const { classes } = settings;
  if (!Array.isArray(classes)) fail("Native classes must be a list.");
  // The supplied compatibility list must reflect native set priority and tombstones.
  // Do not silently regenerate it and lose unknown fields from either representation.
  if (!equal(classes, merged)) fail("classes must equal the effective categories in active-set order, including primary tombstones.");
}

export function effectiveCategories(settings) {
  validateCategorySets(settings);
  const { category_sets: sets, active_set_ids: active } = settings;
  const ordered = active.map(id => sets.find(s => s.id === id));
  const seen = new Set();
  const hidden = new Set(ordered[0].tombstones ?? []);
  const merged = [];
  ordered.forEach((set, index) => {
    for (const category of set.categories) {
      const key = JSON.stringify(category.name);
      if (seen.has(key) || (index > 0 && hidden.has(key))) continue;
      seen.add(key);
      merged.push(category);
    }
  });
  return merged;
}

export function validateCategorySets(settings, { allowMissingActiveIds = false } = {}) {
  if (!object(settings)) fail("Category settings must be an object.");
  const { category_sets: sets, active_set_ids: active } = settings;
  if (!Array.isArray(sets) || !sets.length || !Array.isArray(active) || !active.length) fail("Nonempty native sets and active IDs are required; empty selection would activate a native fallback.");
  const ids = new Set();
  for (const set of sets) {
    if (!object(set) || typeof set.id !== "string" || !set.id || ids.has(set.id) || !Array.isArray(set.categories)) fail("Invalid or duplicate native category set.");
    ids.add(set.id);
    const names = new Set();
    for (const category of set.categories) {
      validateCategory(category);
      const name = JSON.stringify(category.name);
      if (names.has(name)) fail("Duplicate category name in one set.");
      names.add(name);
    }
    if (set.tombstones !== undefined) {
      if (!Array.isArray(set.tombstones)) fail("Invalid tombstones.");
      for (const tombstone of set.tombstones) {
        try { if (typeof tombstone !== "string" || !validName(JSON.parse(tombstone))) throw Error(); } catch { fail("Tombstones must be JSON-encoded category paths."); }
      }
    }
  }
  const missing = active.some(id => !ids.has(id));
  if (new Set(active).size !== active.length ||
      active.some(id => typeof id !== "string" || !id) ||
      (missing && !allowMissingActiveIds)) fail("Active IDs must be unique and refer to supplied sets.");
  return missing;
}

export function validateCategory(category) {
  if (!object(category) || !validName(category.name) || !object(category.rule) || !["regex", "none", null].includes(category.rule.type)) fail("Unsupported native category shape or rule type.");
  const rule = category.rule;
  if (rule.type === "regex") {
    if (typeof rule.regex !== "string") fail("Regex rules require a string pattern.");
    try { new RegExp(rule.regex); } catch { fail("Invalid native regex pattern."); }
  }
  if (rule.ignore_case !== undefined && typeof rule.ignore_case !== "boolean") fail("ignore_case must be boolean.");
  if (rule.select_keys !== undefined && (!Array.isArray(rule.select_keys) || rule.select_keys.some(k => typeof k !== "string" || !k))) fail("Invalid select_keys.");
  for (const key of ["priority", "weight"]) if (rule[key] !== undefined && !Number.isInteger(rule[key])) fail(`Invalid rule ${key}.`);
}

function validName(name) { return Array.isArray(name) && name.length > 0 && name.every(v => typeof v === "string" && v.length > 0); }

async function readDocument(file) {
  if (!file) fail("A document path is required.");
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > DOCUMENT_LIMIT) fail("Document exceeds the 8 MiB limit.");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!isUtf8(bytes)) fail("Native document must be valid UTF-8.");
  return parseNativeJson(bytes.toString("utf8"), "Document is not valid JSON.");
}

function documentBytes(document) {
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > DOCUMENT_LIMIT) {
    const message = document.format === BACKUP_FORMAT
      ? "The native backup would exceed the 8 MiB restore limit."
      : "The native export would exceed the 8 MiB document limit.";
    fail(message, "UNSUPPORTED");
  }
  return bytes;
}

async function privateFile(file, bytes) {
  try { await writeFile(absolutePath(file), bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code === "EEXIST") fail("Backup/export already exists. Choose a new private file.", "CONFLICT");
    throw error;
  }
}
