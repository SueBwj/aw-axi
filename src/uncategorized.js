import { AxiError } from "axi-sdk-js";
import { getBuckets, queryBucket, selectByType } from "./client.js";
import { nowFrom } from "./options.js";
import { loadCompleteRules } from "./rules.js";
import { formatInstant, intersect, rangeFrom, secondsFromMs, timeZoneFrom } from "./time.js";

export async function uncategorized(flags, client) {
  const loaded = await loadCompleteRules(flags, client);
  compileRules(loaded.categories);
  const now = nowFrom(flags);
  const timeZone = timeZoneFrom(flags);
  const range = rangeFrom(flags, now, timeZone);
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
  const remainders = windowPieces.flatMap((piece) => subtract(piece, webPieces));
  const appPieces = remainders
    .filter((piece) => !categorized(piece.event, loaded.categories))
    .map((piece) => ({ ...piece, key: appName(piece.event) }));
  const domainPieces = webPieces
    .filter((piece) => !categorized(piece.event, loaded.categories))
    .map((piece) => ({ ...piece, key: domainName(piece.event) }));
  const apps = rows(allocate(appPieces), "name");
  const domains = rows(allocate(domainPieces), "domain");
  return {
    ...header,
    afk_filter: notAfk ? "applied" : "unavailable",
    overlap: "overlapping time is counted once",
    apps_count: apps.length,
    apps: apps.length === 0 ? "0 uncategorized apps in this range" : apps,
    domains_count: domains.length,
    domains: domains.length === 0 ? "0 uncategorized domains in this range" : domains,
  };
}

async function piecesFrom(client, bucket, range, notAfk) {
  if (!bucket) return [];
  const events = await queryBucket(client, bucket.id, range.start, range.end);
  return events.flatMap((event) => clipEvent(event, range, notAfk));
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
    const piece = clipEvent(event, range, null)[0];
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
  return intervals.filter((interval) => interval.status === "not-afk");
}

function clipEvent(event, range, notAfk) {
  const start = Date.parse(event?.timestamp);
  const durationMs = Number(event?.duration) * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs <= 0) return [];
  const bounded = intersect(start, start + durationMs, range.start.epochMilliseconds, range.end.epochMilliseconds);
  if (!bounded) return [];
  const base = { ...bounded, event };
  if (!notAfk) return [base];
  return notAfk
    .map((interval) => {
      const clipped = intersect(base.start, base.end, interval.start, interval.end);
      return clipped ? { ...clipped, event } : null;
    })
    .filter(Boolean);
}

function subtract(piece, covers) {
  let parts = [{ start: piece.start, end: piece.end }];
  for (const cover of covers) {
    const next = [];
    for (const part of parts) {
      if (cover.end <= part.start || cover.start >= part.end) {
        next.push(part);
        continue;
      }
      if (cover.start > part.start) next.push({ start: part.start, end: Math.min(cover.start, part.end) });
      if (cover.end < part.end) next.push({ start: Math.max(cover.end, part.start), end: part.end });
    }
    parts = next;
  }
  return parts.filter((part) => part.end > part.start).map((part) => ({ ...part, event: piece.event }));
}

function allocate(pieces) {
  const points = new Set();
  for (const piece of pieces) {
    points.add(piece.start);
    points.add(piece.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const totals = new Map();
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index];
    const end = sorted[index + 1];
    const active = pieces.filter((piece) => piece.start <= start && piece.end >= end);
    if (active.length === 0) continue;
    active.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const key = active[0].key;
    totals.set(key, (totals.get(key) ?? 0) + (end - start));
  }
  return totals;
}

function rows(totals, field) {
  return [...totals.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, ms]) => ({ [field]: key, seconds: secondsFromMs(ms) }));
}

function compileRules(categories) {
  for (const category of categories) {
    if (!category?.rule || category.rule.type !== "regex" || !category.rule.regex) continue;
    try {
      category.compiled = new RegExp(category.rule.regex, `${category.rule.ignore_case ? "i" : ""}m`);
    } catch {
      throw new AxiError("A category rule is not a valid regular expression. No aggregates were returned.", "VALIDATION_ERROR");
    }
  }
}

function categorized(event, categories) {
  let best = null;
  let bestRank = null;
  for (const category of categories) {
    const regex = category.compiled;
    if (!regex) continue;
    const keys = Array.isArray(category.rule.select_keys) && category.rule.select_keys.length > 0
      ? category.rule.select_keys
      : ["app", "title", "url"];
    const matched = keys.some((key) => typeof event?.data?.[key] === "string" && regex.test(event.data[key]));
    if (!matched) continue;
    const rank = categoryRank(category);
    if (best === null || rank > bestRank) {
      best = category;
      bestRank = rank;
    }
  }
  return best !== null;
}

function categoryRank(category) {
  const explicit = category.rule?.priority ?? category.rule?.weight;
  if (typeof explicit === "number" && Number.isInteger(explicit)) return explicit;
  return Array.isArray(category.name) ? category.name.length * 10 : 0;
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
