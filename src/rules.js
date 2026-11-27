import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, chown, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AxiError } from "axi-sdk-js";
import { getSetting } from "./client.js";
import { decimalParts, parseReplayJson } from "./json-numbers.js";
import { withLock } from "./lock.js";
import { effectiveCategories, validateCategory, validateCategorySets } from "./native-rules.js";
import { absolutePath } from "./options.js";
import { revisionOf, revisionOfBytes, stableStringify } from "./revision.js";

const FORMAT = "activitywatch-axi.rules.v1";
const execFileAsync = promisify(execFile);

export async function rulesShow(flags, client) {
  const document = await readServerRules(client);
  const coverage = coverageOf(document);
  const body = {
    revision: revisionOf(document),
    coverage,
    category_sets: Array.isArray(document.category_sets) ? document.category_sets.length : null,
    active_set_ids: Array.isArray(document.active_set_ids) ? document.active_set_ids : null,
    classes: Array.isArray(document.classes) ? document.classes.length : null,
    browser_extension: "not-readable",
  };
  if (coverage === "unsupported") {
    body.result =
      "These keys are absent/incomplete. The native UI may use shipped defaults or browser fallback. Run rules show --native for version-pinned detection; browser storage was not read.";
    body.help = [
      "Export the rules from the browser UI and run `aw-axi rules preview --file <path>`.",
      "A single exported category list does not include other enabled sets or their priority.",
    ];
  }
  if (flags.full && coverage !== "unsupported") body.rules = describeRules(document, true);
  else if (coverage === "complete" || coverage === "legacy-classes-only") body.rules = describeRules(document, false);
  return body;
}

export async function rulesExport(flags, client) {
  const file = requirePath(flags.file, "--file");
  const document = await readServerRules(client);
  const coverage = coverageOf(document);
  if (coverage === "unsupported") {
    throw new AxiError(
      "The server has no category settings. This CLI cannot see browser-local rules and did not write a file.",
      "UNSUPPORTED",
      ["Save the browser export yourself, then run `aw-axi rules preview --file <path>`."],
    );
  }
  const payload = {
    format: FORMAT,
    coverage: coverage === "complete" ? "server-sets" : "legacy-classes-only",
    browser_extension: "not-readable",
    category_sets: document.category_sets,
    active_set_ids: document.active_set_ids,
    classes: document.classes,
  };
  const contents = `${JSON.stringify(payload, null, 2)}\n`;
  await writeNewFile(file, contents);
  return {
    result: "exported",
    file,
    coverage: payload.coverage,
    browser_extension: "not-readable",
    revision: revisionOfBytes(contents),
  };
}

export async function rulesPreview(flags) {
  const file = requirePath(flags.file, "--file");
  const parsed = await readRulesFile(file);
  if (parsed.kind === "array") {
    return {
      file,
      coverage: "first-set-only",
      partial: true,
      categories: parsed.value.length,
      result:
        "This file is one category list. Other enabled sets and their priority are not in it, so it is not a complete configuration.",
      rules: flags.full ? summarizeCategories(parsed.value, true) : `${parsed.value.length} categories`,
    };
  }
  if (parsed.kind !== "document") {
    throw new AxiError(
      "The rules file is neither a category list nor an activitywatch-axi rules document.",
      "VALIDATION_ERROR",
    );
  }
  const coverage = parsed.value.coverage ?? "unknown";
  const missingActiveIds = (coverage === "complete" || coverage === "server-sets") &&
    validateCategorySets(parsed.value, { allowMissingActiveIds: true });
  return {
    file,
    coverage: missingActiveIds ? "incomplete" : coverage,
    partial: missingActiveIds || coverage !== "complete",
    ...(missingActiveIds ? { result: "Preview only. An active set is missing, so these rules cannot be used to categorize activity." } : {}),
    revision: revisionOfBytes(parsed.bytes),
    browser_extension: parsed.value.browser_extension ?? null,
    unknown_fields: unknownFields(parsed.value, [
      "format",
      "coverage",
      "browser_extension",
      "category_sets",
      "active_set_ids",
      "classes",
    ]),
    rules: describeRules(rulesPayload(parsed.value), Boolean(flags.full)),
  };
}

export async function rulesAdd(flags) {
  const expect = requireExpect(flags.expect);
  const backup = requirePath(flags.backup, "--backup");
  const edit = parseEdit(flags);
  if (flags.file && flags.server) {
    throw new AxiError("Pass either --file or --server", "VALIDATION_ERROR");
  }
  if (flags.file) return addFile(flags.file, edit, expect, backup);
  if (flags.server) throw new AxiError("Server edits require a complete native document. Use rules export --native, then rules apply.", "UNSUPPORTED");
  throw new AxiError("Pass --file or --server", "VALIDATION_ERROR");
}

export async function rulesRevert(flags) {
  const expect = requireExpect(flags.expect);
  const backup = requirePath(flags.backup, "--backup");
  if (flags.file && flags.server) {
    throw new AxiError("Pass either --file or --server", "VALIDATION_ERROR");
  }
  if (flags.file) return revertFile(flags.file, backup, expect);
  if (flags.server) throw new AxiError("Use rules revert --native with a target-bound native backup and --save-backup.", "UNSUPPORTED");
  throw new AxiError("Pass --file or --server", "VALIDATION_ERROR");
}

export async function loadCompleteRules(flags, client) {
  if (flags.rules && flags["server-rules"]) {
    throw new AxiError("Pass either --rules or --server-rules", "VALIDATION_ERROR");
  }
  if (flags.rules) {
    const parsed = await readRulesFile(requirePath(flags.rules, "--rules"), parseRuleStructure);
    if (parsed.kind === "array") {
      throw new AxiError(
        "This rules file is only the first category set. Categorization was not run.",
        "UNSUPPORTED",
        ["Include every enabled set and active_set_ids in an activitywatch-axi rules file with coverage complete."],
      );
    }
    if (parsed.kind !== "document" || parsed.value.coverage !== "complete") {
      throw new AxiError(
        `Rules coverage is ${parsed.value?.coverage ?? "unknown"}. Categorization was not run.`,
        "UNSUPPORTED",
        ["Use a file whose coverage is complete, including every enabled set and its priority."],
      );
    }
    return { scope: "complete", categories: effectiveCategories(parsed.value) };
  }
  if (flags["server-rules"]) {
    const [category_sets, active_set_ids] = await Promise.all([
      getSetting(client, "category_sets", parseRuleStructure),
      getSetting(client, "active_set_ids", JSON.parse),
    ]);
    try {
      return { scope: "server-sets-only", categories: effectiveCategories({ category_sets, active_set_ids }) };
    } catch (error) {
      if (!(error instanceof AxiError) || error.code !== "VALIDATION_ERROR") throw error;
      throw new AxiError(
        "Server category settings are missing or incomplete. No default rules were used and categorization was not run.",
        "UNSUPPORTED",
        ["Browser-local rules were not searched. Pass --rules with an explicit complete file."],
      );
    }
  }
  throw new AxiError("Pass --rules <file> or --server-rules before categorizing", "VALIDATION_ERROR", [
    "Missing rules are reported as unsupported. They are not treated as an empty uncategorized total.",
  ]);
}

async function addFile(file, edit, expect, backup) {
  return editRulesFile(file, expect, async ({ absolute, target, original, parsed }) => {
    const next = applyAdd(parsed, edit);
    if (stableStringify(rulesPayload(parsed)) === stableStringify(rulesPayload(next.document))) {
      return { result: "no-op", file: absolute, revision: expect, masked: next.masked };
    }
    const contents = `${JSON.stringify(next.document, null, 2)}\n`;
    await replaceFile(absolute, target, original, contents, backup);
    return {
      result: "updated",
      file: absolute,
      backup,
      revision: revisionOfBytes(contents),
      masked: next.masked,
      server_transaction: "unsupported",
    };
  });
}

async function revertFile(file, backup, expect) {
  return editRulesFile(file, expect, async ({ absolute, target, original }) => {
    const bytes = await readFile(backup);
    parseDocumentBytes(bytes, parseRuleStructure);
    if (original.equals(bytes)) return { result: "no-op", file: absolute, backup, revision: expect };
    await replaceFile(absolute, target, original, bytes);
    return { result: "restored", file: absolute, backup, revision: revisionOfBytes(bytes) };
  }, parseRuleStructure);
}

async function editRulesFile(file, expect, edit, parse) {
  const absolute = requirePath(file, "--file");
  const target = await realpath(absolute);
  return withLock(path.dirname(target), `.aw-axi-rules-${revisionOf(target)}`, async () => {
    if (await realpath(absolute) !== target) {
      throw new AxiError("The rules file destination changed before it was read. The file was not replaced.", "CONFLICT");
    }
    const original = await readFile(target);
    const parsed = parseDocumentBytes(original, parse);
    assertExpect(original, expect);
    return edit({ absolute, target, original, parsed });
  });
}

function applyAdd(document, edit) {
  const next = structuredClone(document);
  const sets = next.category_sets;
  const set = sets.find((item) => item.id === edit.setId);
  if (!set) {
    throw new AxiError(`Category set ${JSON.stringify(edit.setId)} is not in the document.`, "NOT_FOUND", [
      ...sets.map((item) => `set ${item.id}`),
    ]);
  }
  const key = JSON.stringify(edit.name);
  const existing = set.categories.find((category) => JSON.stringify(category.name) === key);
  if (!existing) {
    const rule = { type: "regex", regex: edit.pattern };
    set.categories.push({ name: edit.name, rule });
  } else {
    const rule = existing.rule;
    if (rule.type === "regex") {
      if (rule.regex !== edit.pattern) {
        if (hasBackreference(rule.regex) || hasBackreference(edit.pattern)) {
          throw new AxiError("Cannot append a regex alternative with backreferences.", "VALIDATION_ERROR");
        }
        rule.regex = `${rule.regex}|${edit.pattern}`;
      }
    } else {
      rule.type = "regex";
      rule.regex = edit.pattern;
    }
  }
  const edited = set.categories.find((category) => JSON.stringify(category.name) === key);
  if (edit.ignoreCase) edited.rule.ignore_case = true;
  if (edit.selectKeys) edited.rule.select_keys = edit.selectKeys;
  const payload = rulesPayload(next);
  const merged = effectiveCategories(payload);
  payload.classes = merged.map((category) => structuredClone(category));
  next.classes = payload.classes;
  const winner = merged.find((category) => JSON.stringify(category.name) === key);
  const masked = Boolean(winner && winner !== edited);
  return { document: next, masked };
}

function hasBackreference(pattern) {
  const tokens = /(\\[1-9k])|\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]/g;
  return pattern.matchAll(tokens).some((match) => Boolean(match[1]));
}

function rulesPayload(document) {
  return {
    category_sets: document.category_sets ?? null,
    active_set_ids: document.active_set_ids ?? null,
    classes: document.classes ?? null,
  };
}

export function coverageOf(document) {
  if (document?.category_sets != null || document?.active_set_ids != null) {
    try {
      validateCategorySets(document);
      return "complete";
    } catch {
      return "unsupported";
    }
  }
  if (document?.category_sets == null && Array.isArray(document?.classes)) return "legacy-classes-only";
  return "unsupported";
}

function describeRules(document, full) {
  if (Array.isArray(document.category_sets)) {
    return document.category_sets.map((set) => ({
      id: set?.id ?? null,
      active: Array.isArray(document.active_set_ids) && document.active_set_ids.includes(set?.id),
      categories: Array.isArray(set?.categories) ? set.categories.length : null,
      ...(full ? { rules: summarizeCategories(set?.categories ?? [], true) } : {}),
      unknown_fields: unknownFields(set ?? {}, ["id", "categories", "tombstones"]),
    }));
  }
  if (Array.isArray(document.classes)) {
    return full ? summarizeCategories(document.classes, true) : `${document.classes.length} legacy categories`;
  }
  return "0 category sets";
}

function summarizeCategories(categories, full) {
  return categories.map((category) => {
    const regex = category?.rule?.regex;
    const shown =
      typeof regex === "string" && regex.length > 80 && !full
        ? `${regex.slice(0, 80)}… (${regex.length} chars)`
        : regex ?? null;
    return { name: (category?.name ?? []).join(" > "), regex: full ? regex ?? null : shown };
  });
}

function unknownFields(value, known) {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).filter((key) => !known.includes(key));
}

function parseEdit(flags) {
  if (!flags.set || !flags.name || !flags.pattern) {
    throw new AxiError("--set, --name, and --pattern are required", "VALIDATION_ERROR");
  }
  const name = flags.name.split(">").map((part) => part.trim());
  if (name.some((part) => part.length === 0)) {
    throw new AxiError("--name must be a > separated category path", "VALIDATION_ERROR");
  }
  if (flags.pattern.length === 0 || flags.pattern.length > 2000) {
    throw new AxiError("--pattern must be 1 to 2000 characters", "VALIDATION_ERROR");
  }
  try {
    new RegExp(flags.pattern);
  } catch {
    throw new AxiError("The pattern is not a valid regular expression. Nothing was written.", "VALIDATION_ERROR");
  }
  const selectKeys = flags["select-keys"]?.split(",").map((part) => part.trim()).filter(Boolean);
  if (selectKeys?.length === 0) {
    throw new AxiError("--select-keys requires at least one field name", "VALIDATION_ERROR");
  }
  return { setId: flags.set, name, pattern: flags.pattern, ignoreCase: Boolean(flags["ignore-case"]), selectKeys };
}

async function readServerRules(client) {
  const [categorySets, activeIds, classes] = await Promise.all([
    getSetting(client, "category_sets"),
    getSetting(client, "active_set_ids"),
    getSetting(client, "classes"),
  ]);
  return { category_sets: categorySets, active_set_ids: activeIds, classes };
}

async function readRulesFile(file, parse) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new AxiError(`Rules file not found: ${file}`, "NOT_FOUND");
    }
    throw error;
  }
  const value = parseRulesJson(bytes, parse);
  if (Array.isArray(value)) return { kind: "array", value };
  if (value && typeof value === "object" && value.format === FORMAT) {
    return { kind: "document", value, bytes };
  }
  return { kind: "other", value };
}

function parseDocumentBytes(bytes, parse) {
  const value = parseRulesJson(bytes, parse);
  if (!value || typeof value !== "object" || Array.isArray(value) || value.format !== FORMAT) {
    throw new AxiError(
      "Refusing to edit a file that is not an activitywatch-axi rules document.",
      "UNSUPPORTED",
      ["A first-set-only export cannot be edited into a complete configuration."],
    );
  }
  if (value.coverage !== "complete" && value.coverage !== "server-sets") {
    throw new AxiError(
      `Refusing to edit coverage ${value.coverage ?? "unknown"}.`,
      "UNSUPPORTED",
    );
  }
  validateCategorySets(value);
  if (value.classes != null) {
    if (!Array.isArray(value.classes)) {
      throw new AxiError("Legacy classes must be a list or null.", "VALIDATION_ERROR");
    }
    value.classes.forEach(validateCategory);
  }
  return value;
}

function parseRulesJson(bytes, parse = text => parseReplayJson(text, "VALIDATION_ERROR")) {
  try {
    return parse(bytes.toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AxiError("The rules file is not JSON. It was not modified.", "VALIDATION_ERROR");
  }
}

function parseRuleStructure(text) {
  return JSON.parse(text, (key, value, context) => {
    if ((key === "priority" || key === "weight") && Number.isInteger(value) &&
        decimalParts(context.source).exponent < 0) return NaN;
    return value;
  });
}

function assertExpect(bytes, expect) {
  const actual = revisionOfBytes(bytes);
  if (actual !== expect) {
    throw new AxiError(
      `The current revision is ${actual}, not ${expect}. Nothing was written.`,
      "CONFLICT",
      ["Read the document again and pass its current revision as --expect."],
    );
  }
}

function requireExpect(value) {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) {
    throw new AxiError("--expect must be the current sha256 revision", "VALIDATION_ERROR");
  }
  return value;
}

function requirePath(value, flag) {
  if (!value) throw new AxiError(`${flag} is required`, "VALIDATION_ERROR");
  return absolutePath(value);
}

async function writeNewFile(file, contents) {
  try {
    await writeFile(file, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new AxiError(`${file} already exists. Choose a new path so the previous bytes stay intact.`, "CONFLICT");
    }
    throw error;
  }
}

async function requirePlainPermissions(file) {
  const darwin = process.platform === "darwin";
  const args = darwin ? ["-ldbe@", file]
    : process.platform === "linux" ? ["-ld", "--quoting-style=escape", "--", file] : null;
  if (args) {
    const listing = await execFileAsync("ls", args, { env: { ...process.env, LC_ALL: "C" } }).catch(() => null);
    const plain = /^[-d][rwxstST-]{9}[ \t][^\r\n]*\n$/;
    const provenanceOnly = /^[-d][rwxstST-]{9}@[ \t][^\r\n]*\n\tcom\.apple\.provenance\t[ \t]*\d+[ \t]*\n$/;
    if (listing && (plain.test(listing.stdout) || (darwin && provenanceOnly.test(listing.stdout)))) return;
  }
  throw new AxiError("Cannot verify that the rules file or staging directory has plain permissions. The file was not replaced.", "UNSUPPORTED");
}

async function replaceFile(requested, file, original, contents, backup) {
  await access(file, constants.W_OK);
  const { uid, gid, mode, dev, ino, ctimeMs } = await stat(file);
  await requirePlainPermissions(file);
  if (backup) await writeNewFile(backup, original);
  const staging = await mkdtemp(path.join(path.dirname(file), ".aw-axi-"));
  const replacement = path.join(staging, "rules.json");
  try {
    await requirePlainPermissions(staging);
    await writeFile(replacement, contents, { mode: 0o600, flush: true });
    const staged = await stat(replacement);
    if (staged.uid !== uid || staged.gid !== gid) await chown(replacement, uid, gid);
    await chmod(replacement, mode & 0o777);
    await requirePlainPermissions(replacement);
    const current = await readFile(file);
    const metadata = await stat(file);
    if (!current.equals(original) || metadata.dev !== dev || metadata.ino !== ino || metadata.ctimeMs !== ctimeMs ||
        metadata.uid !== uid || metadata.gid !== gid || metadata.mode !== mode ||
        await realpath(requested) !== file) {
      throw new AxiError("The rules file or its destination changed after it was read. The file was not replaced.", "CONFLICT");
    }
    await rename(replacement, file);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
