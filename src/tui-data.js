import { AxiError } from "axi-sdk-js";
import { getBuckets, getEvents, getSetting, queryBucket, selectByType } from "./client.js";
import { clientFrom, nowFrom } from "./options.js";
import { instantFromDate, intersect, rangeFrom, timeZoneFrom, unionMs } from "./time.js";

const READ_LIMIT = 10000;
const NATIVE_KEYS = ["category_sets", "active_set_ids", "classes"];

export function sanitizeTerminal(value) {
  return String(value ?? "")
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "");
}

export function displayWidth(text) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let width = 0;
  for (const { segment } of segmenter.segment(String(text))) width += graphemeWidth(segment);
  return width;
}

function graphemeWidth(segment) {
  if (!segment) return 0;
  if (/\p{Extended_Pictographic}/u.test(segment)) return 2;
  for (const char of segment) {
    const code = char.codePointAt(0);
    if (isWide(code)) return 2;
  }
  return 1;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

export function clipDisplay(text, width) {
  const clean = sanitizeTerminal(text);
  if (width <= 0) return "";
  if (displayWidth(clean) <= width) return clean;
  if (width === 1) return "…";
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(clean)) {
    const next = graphemeWidth(segment);
    if (used + next > width - 1) break;
    out += segment;
    used += next;
  }
  return `${out}…`;
}

export function padDisplay(text, width, align = "end") {
  const shown = clipDisplay(text, width);
  const gap = Math.max(0, width - displayWidth(shown));
  const spaces = " ".repeat(gap);
  return align === "start" ? shown + spaces : spaces + shown;
}

export function formatDuration(ms) {
  const sign = ms < 0 ? "-" : "";
  const total = Math.abs(Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return sign + parts.join(" ");
}

export function reduceDomain(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return host || null;
}

export function tuiRange(flags, now, timeZone, mode = "today") {
  if (flags.start !== undefined || flags.end !== undefined) {
    const range = rangeFrom(flags, now, timeZone);
    return { ...range, mode: "explicit" };
  }
  const zoned = instantFromDate(now).toZonedDateTimeISO(timeZone);
  const end = zoned.toInstant();
  const start = mode === "seven" ? zoned.subtract({ days: 7 }).toInstant() : zoned.startOfDay().toInstant();
  return { start, end, timeZone, defaulted: true, mode: mode === "seven" ? "seven" : "today" };
}

export function partitionAfk(startMs, endMs, events) {
  const totals = { elapsed: Math.max(0, endMs - startMs), notAfk: 0, afk: 0, overlap: 0, missing: 0, unrecognized: 0, invalid: 0 };
  if (endMs <= startMs) return { ...totals, complete: true };
  const clipped = [];
  for (const event of events ?? []) {
    const start = Date.parse(event?.timestamp);
    const durationMs = Number(event?.duration) * 1000;
    if (!Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs <= 0) {
      totals.invalid += 1;
      continue;
    }
    const piece = intersect(start, start + durationMs, startMs, endMs);
    if (!piece) continue;
    const status = event?.data?.status;
    const kind = status === "afk" || status === "not-afk" ? status : "unrecognized";
    clipped.push({ ...piece, kind });
  }
  const points = new Set([startMs, endMs]);
  for (const interval of clipped) {
    points.add(interval.start);
    points.add(interval.end);
  }
  for (const [lo, hi] of spans([...points].sort((a, b) => a - b), startMs, endMs)) {
    const covering = clipped.filter((interval) => interval.start <= lo && interval.end >= hi);
    const span = hi - lo;
    if (covering.length === 0) totals.missing += span;
    else if (covering.length > 1) totals.overlap += span;
    else if (covering[0].kind === "unrecognized") totals.unrecognized += span;
    else if (covering[0].kind === "afk") totals.afk += span;
    else totals.notAfk += span;
  }
  const complete = totals.missing === 0 && totals.overlap === 0 && totals.unrecognized === 0 && totals.invalid === 0;
  return { ...totals, complete };
}

export function activityUnions(startMs, endMs, events, keyOf) {
  const intervals = [];
  let invalid = 0;
  let truncated = false;
  const list = events ?? [];
  if (list.length >= READ_LIMIT) truncated = true;
  if (!truncated) {
    for (const event of list) {
      const start = Date.parse(event?.timestamp);
      const durationMs = Number(event?.duration) * 1000;
      if (!Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs <= 0) {
        invalid += 1;
        continue;
      }
      const piece = intersect(start, start + durationMs, startMs, endMs);
      if (!piece) continue;
      intervals.push({ ...piece, key: keyOf(event) });
    }
  }
  const union = unionMs(intervals);
  const grouped = new Map();
  for (const interval of intervals) {
    const rows = grouped.get(interval.key) ?? [];
    rows.push(interval);
    grouped.set(interval.key, rows);
  }
  const rows = [...grouped.entries()]
    .map(([key, pieces]) => ({ key, ms: unionMs(pieces).union }))
    .sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const rowSum = rows.reduce((sum, row) => sum + row.ms, 0);
  return {
    union: truncated ? null : union.union,
    overlap: truncated ? null : union.overlap,
    rows: truncated ? [] : rows,
    invalid,
    truncated,
    rowsOverlap: !truncated && rowSum > union.union,
  };
}

export function windowKey(event) {
  const app = sanitizeTerminal(event?.data?.app);
  return app.trim() ? app : "(unnamed)";
}

export function webKey(event) {
  return reduceDomain(event?.data?.url);
}

function spans(points, startMs, endMs) {
  const pairs = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const lo = points[index];
    const hi = points[index + 1];
    if (hi > lo && lo >= startMs && hi <= endMs) pairs.push([lo, hi]);
  }
  return pairs;
}

export async function loadDashboard(flags, client, mode = "today") {
  const now = nowFrom(flags);
  const timeZone = timeZoneFrom(flags);
  const range = tuiRange(flags, now, timeZone, mode);
  const anchor = range.end.toZonedDateTimeISO(timeZone);
  const buckets = await getBuckets(client);
  const windows = selectByType(buckets, "currentwindow", flags.host);
  const webs = selectByType(buckets, "web.tab.current", flags.host);
  const afks = selectByType(buckets, "afkstatus", flags.host);
  if (windows.length > 1 || webs.length > 1 || afks.length > 1) {
    throw new AxiError(
      "More than one window, web, or AFK bucket matches. Pass --host. No event contents were returned.",
      "AMBIGUOUS",
      [...windows, ...webs, ...afks].map((bucket) => `${bucket.id} hostname ${bucket.hostname ?? "unknown"}`),
    );
  }
  const startMs = range.start.epochMilliseconds;
  const endMs = range.end.epochMilliseconds;
  const windowEvents = windows[0] ? await queryBucket(client, windows[0].id, range.start, range.end) : null;
  const webEvents = webs[0] ? await queryBucket(client, webs[0].id, range.start, range.end) : null;
  const afkEvents = afks[0] ? await queryBucket(client, afks[0].id, range.start, range.end) : null;
  const apps = windowEvents
    ? activityUnions(startMs, endMs, windowEvents, windowKey)
    : { union: null, overlap: null, rows: [], invalid: 0, truncated: false, rowsOverlap: false, absent: true };
  const domains = [];
  let webInvalid = 0;
  let webTruncated = false;
  if (webEvents) {
    if (webEvents.length >= READ_LIMIT) webTruncated = true;
    else {
      for (const event of webEvents) {
        if (!webKey(event)) webInvalid += 1;
      }
    }
  }
  const web = webEvents
    ? activityUnions(startMs, endMs, webTruncated ? [] : webEvents.filter((event) => webKey(event)), (event) => webKey(event))
    : { union: null, overlap: null, rows: [], invalid: 0, truncated: false, rowsOverlap: false, absent: true };
  web.invalid += webInvalid;
  web.truncated = web.truncated || webTruncated;
  if (webTruncated) {
    web.union = null;
    web.rows = [];
  }
  const afk = afkEvents
    ? afkEvents.length >= READ_LIMIT
      ? { truncated: true, complete: false }
      : { ...partitionAfk(startMs, endMs, afkEvents), truncated: false }
    : { absent: true, complete: false, truncated: false };
  const model = {
    ok: true,
    host: flags.host || singleHost(windows[0] || webs[0] || afks[0]),
    timeZone,
    mode: range.mode,
    anchor: formatAnchor(anchor),
    elapsed: Math.max(0, endMs - startMs),
    apps,
    web,
    afk,
    timers: await timerCard(flags, client, startMs, endMs, now.getTime()),
  };
  model.categories = await categoryCard(client);
  model.uncategorized = uncategorizedCard(afk, apps, model.categories);
  return model;
}

function singleHost(bucket) {
  const host = sanitizeTerminal(bucket?.hostname ?? "");
  return host || "unfiltered";
}

function formatAnchor(zoned) {
  return zoned.toPlainDateTime().toString({ smallestUnit: "minute" }).replace("T", " ");
}

function uncategorizedCard(afk, apps, categories) {
  if (afk.absent || afk.truncated || !afk.complete) {
    return {
      state: "refused",
      reason: "AFK coverage is missing, overlapping, truncated, or unrecognized. No status was chosen by sort order.",
    };
  }
  if (apps.rowsOverlap) {
    return {
      state: "refused",
      reason: "Window intervals overlap. They were not assigned to one app by name order.",
    };
  }
  if (categories.state === "withheld") {
    return {
      state: "withheld",
      reason: "Uncategorized stays withheld. Window events do not carry browser URLs, and overlapping names are not assigned by sort order.",
    };
  }
  return {
    state: "unavailable",
    reason: "No complete native rule set is applied here. No default rules were created.",
  };
}

async function categoryCard(client) {
  const presence = {};
  try {
    for (const key of NATIVE_KEYS) presence[key] = await getSetting(client, key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { state: "unavailable", reason: `Native category settings were not read. ${sanitizeTerminal(message)} Defaults were not created.` };
  }
  const complete = NATIVE_KEYS.every((key) => presence[key] !== null && presence[key] !== undefined);
  if (!complete) {
    return { state: "unavailable", reason: "No complete native rule set. Defaults were not created." };
  }
  return {
    state: "withheld",
    reason: "A native rule set is present. Desktop totals stay withheld: window events do not carry browser URLs, so a domain rule does not change desktop Uncategorized.",
  };
}

async function timerCard(flags, client, startMs, endMs, nowMs) {
  let buckets;
  try {
    buckets = await getBuckets(client);
  } catch (error) {
    throw error;
  }
  const matches = Object.values(buckets).filter((bucket) => bucket?.type === "general.stopwatch");
  const chosen = flags.bucket ? matches.filter((bucket) => bucket.id === flags.bucket) : matches;
  if (flags.bucket && chosen.length === 0) {
    return { state: "missing", reason: "The named stopwatch bucket was not found. Foreground time was not substituted." };
  }
  if (chosen.length > 1) {
    return { state: "ambiguous", reason: "More than one stopwatch bucket matches. Pass --bucket. Totals were not added to foreground." };
  }
  if (chosen.length === 0) {
    return { state: "empty", rows: [], reason: "No stopwatch bucket. Manual timers are not part of foreground time." };
  }
  let events;
  try {
    events = await getEvents(client, chosen[0].id);
  } catch (error) {
    if (error instanceof AxiError && error.code === "INCOMPLETE") {
      return { state: "truncated", reason: "The stopwatch read stopped at 10000 events. Totals were withheld and foreground time was not substituted." };
    }
    throw error;
  }
  const byLabel = new Map();
  let invalid = 0;
  for (const event of events) {
    const label = sanitizeTerminal(event?.data?.label).trim();
    if (!label) {
      invalid += 1;
      continue;
    }
    const start = Date.parse(event?.timestamp);
    const running = event?.data?.running === true;
    const durationMs = running ? nowMs - start : Number(event?.duration) * 1000;
    if (!Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs < 0) {
      invalid += 1;
      continue;
    }
    const piece = intersect(start, start + durationMs, startMs, endMs);
    if (!piece) continue;
    const row = byLabel.get(label) ?? { label, running: [], stored: [] };
    (running ? row.running : row.stored).push(piece);
    byLabel.set(label, row);
  }
  const rows = [...byLabel.values()]
    .map((row) => ({
      label: row.label,
      running: unionMs(row.running).union,
      stored: unionMs(row.stored).union,
    }))
    .filter((row) => row.running > 0 || row.stored > 0)
    .sort((a, b) => b.running + b.stored - (a.running + a.stored) || (a.label < b.label ? -1 : 1));
  return {
    state: "ready",
    rows,
    invalid,
    reason: "Manual timer totals are not added to foreground time.",
  };
}

export async function dashboardFrom(flags, mode) {
  return loadDashboard(flags, clientFrom(flags), mode);
}

export function rangeModeAllowed(flags) {
  return flags.start === undefined && flags.end === undefined;
}
