import { AxiError } from "axi-sdk-js";
import { getBuckets, queryBucket, selectActivityBuckets } from "./client.js";
import { nowFrom } from "./options.js";
import { loadCompleteRules } from "./rules.js";
import { formatInstant, intersect, rangeFrom, secondsFromMs, sweepIntervals, timeZoneFrom } from "./time.js";

const NOT_AFK = Symbol("not-afk");

export async function uncategorized(flags, client) {
  const now = nowFrom(flags);
  const loaded = await loadCompleteRules(flags, client);
  compileRules(loaded.categories);
  const timeZone = timeZoneFrom(flags);
  const range = rangeFrom(flags, now, timeZone);
  const buckets = await getBuckets(client);
  const [windows, webs, afks] = selectActivityBuckets(buckets, flags.host);
  const header = {
    timezone: timeZone,
    start: formatInstant(range.start, timeZone),
    end: formatInstant(range.end, timeZone),
    end_exclusive: true,
    rules_scope: loaded.scope,
    browser_extension: loaded.scope === "server-sets-only" ? "not-included" : "supplied-file",
    match_fields: "app, title, url",
  };
  if (windows.length === 0 && webs.length === 0) {
    return {
      ...header,
      result: "no-activity-buckets",
      afk_filter: afks.length === 0 ? "unavailable" : "not-applied",
      apps_count: 0,
      apps: "0 uncategorized apps in this range",
      domains_count: 0,
      domains: "0 uncategorized domains in this range",
    };
  }
  const notAfk = afks.length === 0 ? null : await notAfkIntervals(client, afks[0], range);
  const windowPieces = await piecesFrom(client, windows[0], range, notAfk);
  const webPieces = await piecesFrom(client, webs[0], range, notAfk);
  const appPieces = windowPieces.map((piece) => ({ ...piece, key: categorized(piece.event, loaded.categories) ? null : appName(piece.event) }));
  const domainPieces = webPieces.map((piece) => ({ ...piece, key: categorized(piece.event, loaded.categories) ? null : domainName(piece.event) }));
  const allowed = notAfk?.map((interval) => ({ ...interval, key: NOT_AFK }));
  const apps = rows(allocate(appPieces, range, allowed), "name");
  const domains = rows(allocate(domainPieces, range, allowed), "domain");
  return {
    ...header,
    afk_filter: notAfk ? "applied" : "unavailable",
    overlap: "same-identity overlaps count once; ambiguous attribution is refused; app and domain measures are separate",
    apps_count: apps.length,
    apps: apps.length === 0 ? "0 uncategorized apps in this range" : apps,
    domains_count: domains.length,
    domains: domains.length === 0 ? "0 uncategorized domains in this range" : domains,
  };
}

async function piecesFrom(client, bucket, range, notAfk) {
  if (!bucket) return [];
  const events = await queryBucket(client, bucket.id, range.start, range.end);
  return events.flatMap((event) => {
    const piece = clipEvent(event, range);
    return piece && (!notAfk || touchesNotAfk(piece, notAfk)) ? [{ ...piece, event }] : [];
  });
}

async function notAfkIntervals(client, bucket, range) {
  const events = await queryBucket(client, bucket.id, range.start, range.end);
  const intervals = [];
  for (const event of events) {
    const status = event?.data?.status;
    if (status !== "afk" && status !== "not-afk") {
      throw new AxiError(
        "An AFK event has an unrecognized status. Categorized totals were not guessed.",
        "INCOMPLETE",
      );
    }
    const piece = clipEvent(event, range);
    if (!piece) continue;
    intervals.push({ ...piece, status });
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].start < intervals[index - 1].end) {
      throw new AxiError(
        "AFK intervals overlap. They were not merged into a guessed activity total.",
        "INCOMPLETE",
      );
    }
  }
  let coveredUntil = range.start.epochMilliseconds;
  for (const interval of intervals) {
    if (interval.start > coveredUntil) break;
    coveredUntil = interval.end;
  }
  if (coveredUntil < range.end.epochMilliseconds) {
    throw new AxiError("AFK coverage is incomplete for this range. No app or domain totals were returned.", "INCOMPLETE");
  }
  return intervals.filter((interval) => interval.status === "not-afk");
}

function clipEvent(event, range) {
  const start = Date.parse(event?.timestamp);
  const durationMs = Number(event?.duration) * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return intersect(start, start + durationMs, range.start.epochMilliseconds, range.end.epochMilliseconds);
}

function touchesNotAfk(piece, notAfk) {
  let first = 0;
  let last = notAfk.length;
  while (first < last) {
    const mid = Math.floor((first + last) / 2);
    if (notAfk[mid].end <= piece.start) first = mid + 1;
    else last = mid;
  }
  return first < notAfk.length && notAfk[first].start < piece.end;
}

function allocate(pieces, range, allowed) {
  if (pieces.length === 0) return new Map();
  const intervals = allowed ? [...pieces, ...allowed] : pieces;
  const totals = new Map();
  sweepIntervals(intervals, range.start.epochMilliseconds, range.end.epochMilliseconds, (span, active) => {
    const notAfk = active.has(NOT_AFK);
    if (allowed && !notAfk) return;
    if (active.size - Number(notAfk) > 1) {
      throw new AxiError("Overlapping activity has ambiguous attribution. No app or domain totals were returned.", "INCOMPLETE");
    }
    for (const key of active.keys()) {
      if (typeof key === "string") totals.set(key, (totals.get(key) ?? 0) + span);
    }
  });
  return totals;
}

function rows(totals, field) {
  return [...totals.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, ms]) => ({ [field]: key, seconds: secondsFromMs(ms) }));
}

function compileRules(categories) {
  for (const category of categories) {
    if (!category?.rule || category.rule.type !== "regex") continue;
    try {
      category.compiled = new RegExp(category.rule.regex, `${category.rule.ignore_case ? "i" : ""}m`);
    } catch {
      throw new AxiError("A category rule is not a valid regular expression. No aggregates were returned.", "VALIDATION_ERROR");
    }
  }
}

function categorized(event, categories) {
  for (const category of categories) {
    const regex = category.compiled;
    if (!regex) continue;
    const keys = Array.isArray(category.rule.select_keys) && category.rule.select_keys.length > 0
      ? category.rule.select_keys
      : ["app", "title", "url"];
    if (keys.some((key) => typeof event?.data?.[key] === "string" && regex.test(event.data[key]))) return true;
  }
  return false;
}

function appName(event) {
  const app = event?.data?.app;
  return typeof app === "string" && app.length > 0 ? app : "(empty)";
}

function domainName(event) {
  const raw = event?.data?.url;
  if (typeof raw !== "string") return "(unparsed)";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "(unparsed)";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "(unparsed)";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return host || "(unparsed)";
}
