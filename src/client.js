import { AxiError } from "axi-sdk-js";
import { Temporal } from "temporal-polyfill";
import { numberReplaysExactly, parseReplayJson } from "./json-numbers.js";

const READ_LIMIT = 10000;
const inexactStopwatchReplays = new WeakSet();
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function createClient(baseUrl, signal, { closeConnection = false } = {}) {
  return {
    baseUrl,
    async request(method, path, { body, mutation = false, expectBody = false, raw = false, parse = JSON.parse } = {}) {
      const url = `${baseUrl}${path}`;
      let response;
      try {
        signal?.throwIfAborted();
        const timeout = AbortSignal.timeout(8000);
        response = await fetch(url, {
          method,
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: body === undefined && !closeConnection ? undefined : {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(closeConnection ? { connection: "close" } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw networkError(error, mutation);
      }
      let text;
      try {
        const reader = response.body?.getReader();
        const chunks = [];
        let size = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new Error("Response exceeds the 8 MiB read limit");
            }
            chunks.push(value);
          }
        }
        text = Buffer.concat(chunks).toString("utf8");
      } catch (error) {
        throw networkError(error, mutation);
      }
      if (response.status >= 500 && mutation) {
        throw new AxiError(
          `ActivityWatch returned HTTP ${response.status} after a write was sent. This command did not retry it.`,
          "UNCERTAIN_WRITE",
          ["Read the current state before trying the command again."],
        );
      }
      if (!response.ok) {
        throw new AxiError(
          `ActivityWatch returned HTTP ${response.status} for ${method} ${path}`,
          response.status === 404 ? "NOT_FOUND" : "SERVER",
          ["The stored data was not changed by this failed response."],
        );
      }
      if (raw) return text;
      if (text === "") {
        if (expectBody && mutation) {
          throw new AxiError(
            "ActivityWatch accepted a write but returned an empty body. This command did not send it again.",
            "UNCERTAIN_WRITE",
            ["Read the current state before trying the command again."],
          );
        }
        return undefined;
      }
      try {
        return parse(text);
      } catch (error) {
        if (error instanceof AxiError) throw error;
        if (mutation) {
          throw new AxiError(
            "ActivityWatch returned a write response that was not JSON. This command did not send it again.",
            "UNCERTAIN_WRITE",
            ["Read the current state before trying the command again."],
          );
        }
        throw new AxiError("ActivityWatch returned a response that was not JSON", "SERVER");
      }
    },
  };
}

const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function describeFailure(error) {
  const codes = [];
  const messages = [];
  const seen = new Set();
  const stack = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (typeof current.code === "string") codes.push(current.code);
    if (typeof current.message === "string") messages.push(current.message);
    if (current.cause) stack.push(current.cause);
    if (Array.isArray(current.errors)) stack.push(...current.errors);
  }
  return { codes, messages, name: error?.name };
}

function neverSent(failure) {
  if (failure.codes.some((code) => NOT_SENT.has(code))) return true;
  return failure.messages.some((message) => /bad port/i.test(message));
}

function redirected(failure) {
  return failure.messages.some((message) => /redirect/i.test(message));
}

function networkError(error, mutation) {
  const failure = describeFailure(error);
  if (redirected(failure)) {
    if (mutation) {
      throw new AxiError(
        "ActivityWatch redirected a write. This command did not follow the redirect or send the write again.",
        "UNCERTAIN_WRITE",
        [
          "Run `aw-axi timer status --base-url <url>` before starting that label again.",
          "A redirect is not proof that the write is missing.",
        ],
      );
    }
    throw new AxiError(
      "ActivityWatch redirected a read. This command did not follow the redirect.",
      "REDIRECT",
      ["The server answered, so this is not a connection failure."],
    );
  }
  if (neverSent(failure) || !mutation) {
    throw new AxiError(
      neverSent(failure)
        ? "ActivityWatch is not accepting connections at this URL."
        : `ActivityWatch could not be read (${failure.codes[0] || failure.name || "network"}).`,
      neverSent(failure) ? "DISCONNECTED" : "SERVER",
      ["Check --base-url. This command did not queue the operation for later."],
    );
  }
  throw new AxiError(
    "A write was sent, but ActivityWatch did not return a response. This command did not retry it.",
    "UNCERTAIN_WRITE",
    [
      "Run `aw-axi timer status --base-url <url>` before starting that label again.",
      "A lost response is not proof that the write is missing.",
    ],
  );
}

export async function getBuckets(client) {
  const value = await client.request("GET", "/api/0/buckets/");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AxiError("ActivityWatch bucket list was not an object", "SERVER");
  }
  return value;
}

export async function getEvents(client, bucketId, { replay = false } = {}) {
  const value = await client.request(
    "GET",
    `/api/0/buckets/${encodeURIComponent(bucketId)}/events?limit=${READ_LIMIT}`,
    { parse: text => parseStopwatchEvents(text, false, replay) },
  );
  if (!Array.isArray(value)) {
    throw new AxiError(`Events for ${bucketId} were not a list`, "SERVER");
  }
  if (value.length >= READ_LIMIT) {
    throw new AxiError(
      `Stopped after reading ${READ_LIMIT} events from ${bucketId}. Acting on a truncated list could drop or duplicate an interval.`,
      "INCOMPLETE",
      ["Narrow the bucket before retrying. This command made no write."],
    );
  }
  return value;
}

export async function postEvents(client, bucketId, events) {
  const value = await client.request(
    "POST",
    `/api/0/buckets/${encodeURIComponent(bucketId)}/events`,
    { body: events, mutation: true, expectBody: true, parse: text => parseStopwatchEvents(text, true) },
  );
  if (!Array.isArray(value) || value.length !== events.length) {
    throw uncertainEventAcknowledgment();
  }
  return value;
}

function parseStopwatchEvents(text, mutation, replay = false) {
  const rounded = new WeakSet();
  const inexactNumbers = replay ? new WeakSet() : null;
  const parsed = JSON.parse(text, function (key, value, context) {
    if (key === "id" && typeof value === "number" && context.source !== String(value)) rounded.add(this);
    if (inexactNumbers && (inexactNumbers.has(value) ||
        (typeof value === "number" && !numberReplaysExactly(value, context.source)))) {
      inexactNumbers.add(this);
      if (key === "timestamp" || key === "data") inexactStopwatchReplays.add(this);
    }
    return value;
  });
  if (Array.isArray(parsed) && parsed.some(event =>
    !Number.isSafeInteger(event?.id) || rounded.has(event))) {
    if (mutation) throw uncertainEventAcknowledgment();
    throw new AxiError("ActivityWatch returned an invalid or inexact stopwatch event id.", "SERVER");
  }
  return parsed;
}

export function assertStopwatchReplay(event) {
  if (inexactStopwatchReplays.has(event)) {
    throw new AxiError("A stopwatch JSON number cannot be replayed without rounding.", "SERVER");
  }
}

export function acknowledgedTimestamp(event, requested) {
  const { timestamp } = event;
  const requestedMs = requested.getTime();
  if (typeof timestamp === "string" && Date.parse(timestamp) === requestedMs) {
    try {
      if (Temporal.Instant.from(timestamp).equals(Temporal.Instant.fromEpochMilliseconds(requestedMs))) return timestamp;
    } catch {
      throw uncertainEventAcknowledgment("event timestamp");
    }
  }
  throw uncertainEventAcknowledgment("event timestamp");
}

function uncertainEventAcknowledgment(field = "event id") {
  return new AxiError(
    `ActivityWatch did not return a verifiable ${field}. This command did not send another event.`,
    "UNCERTAIN_WRITE",
    ["Run `aw-axi timer status --base-url <url>` and compare ids before continuing."],
  );
}

export async function resolveStopwatchBucket(client, explicitId, { create = false } = {}) {
  const buckets = await getBuckets(client);
  const matches = Object.values(buckets).filter((bucket) => bucket.type === "general.stopwatch");
  if (explicitId) {
    const existing = buckets[explicitId];
    if (!existing) {
      if (!create) {
        throw new AxiError(`Stopwatch bucket ${JSON.stringify(explicitId)} was not found.`, "NOT_FOUND");
      }
      if (matches.length > 0) {
        throw new AxiError(
          `Bucket ${explicitId} does not exist, and another stopwatch bucket is already present.`,
          "AMBIGUOUS",
          ["Pass the existing bucket id with --bucket."],
        );
      }
      await createStopwatch(client, explicitId);
      return explicitId;
    }
    if (existing.type !== "general.stopwatch") {
      throw new AxiError(
        `Bucket ${explicitId} has type ${existing.type}. This CLI only writes general.stopwatch buckets.`,
        "AMBIGUOUS",
      );
    }
    return explicitId;
  }
  if (matches.length > 1) {
    throw new AxiError(
      `Found ${matches.length} general.stopwatch buckets. Pass --bucket to choose one.`,
      "AMBIGUOUS",
      matches.map((bucket) => bucket.id),
    );
  }
  if (matches.length === 1) return matches[0].id;
  if (!create) return null;
  await createStopwatch(client, "aw-stopwatch");
  return "aw-stopwatch";
}

async function createStopwatch(client, bucketId) {
  await client.request("POST", `/api/0/buckets/${encodeURIComponent(bucketId)}`, {
    body: {
      client: "activitywatch-axi",
      type: "general.stopwatch",
      hostname: "unknown",
    },
    mutation: true,
  });
}

export async function queryBucket(client, bucketId, start, end) {
  const query = `events = query_bucket(${JSON.stringify(bucketId)});\nRETURN = events;`;
  const period = `${start.toString()}/${end.toString()}`;
  const value = await client.request("POST", "/api/0/query/", {
    body: { timeperiods: [period], query: [query] },
  });
  if (!Array.isArray(value) || !Array.isArray(value[0])) {
    throw new AxiError("ActivityWatch query did not return one event list", "SERVER");
  }
  return value[0];
}

export async function getSetting(client, key, parse = text => parseReplayJson(text, "SERVER")) {
  const value = await client.request("GET", `/api/0/settings/${encodeURIComponent(key)}`, { parse });
  return value === undefined ? null : value;
}

export async function putSetting(client, key, value) {
  await client.request("POST", `/api/0/settings/${encodeURIComponent(key)}`, {
    body: value,
    mutation: true,
  });
}

export function selectByType(buckets, type, host) {
  let list = Object.values(buckets).filter((bucket) => bucket && bucket.type === type);
  if (host) list = list.filter((bucket) => bucket.hostname === host);
  return list;
}

export function selectActivityBuckets(buckets, host) {
  const groups = ["currentwindow", "web.tab.current", "afkstatus"].map((type) => selectByType(buckets, type, host));
  const selected = groups.flat();
  if (groups.some((group) => group.length > 1) || new Set(selected.map((bucket) => bucket.hostname ?? null)).size > 1) {
    throw new AxiError(
      "Activity buckets are ambiguous or belong to different hosts. Pass --host. No event contents were returned.",
      "AMBIGUOUS",
      selected.map((bucket) => `${bucket.id} hostname ${bucket.hostname ?? "unknown"}`),
    );
  }
  return groups;
}
