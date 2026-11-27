import { AxiError } from "axi-sdk-js";
import { acknowledgedTimestamp, assertStopwatchReplay, getEvents, postEvents, resolveStopwatchBucket } from "./client.js";
import { withLock } from "./lock.js";
import { nowFrom, requireEventId, requireLabel, stateDirFrom } from "./options.js";
import { secondsFromMs } from "./time.js";

export async function timerStatus(flags, client) {
  const now = nowFrom(flags);
  const bucketId = await resolveStopwatchBucket(client, flags.bucket);
  if (!bucketId) {
    return { bucket: null, running_count: 0, running: "0 running timers" };
  }
  const events = await getEvents(client, bucketId);
  const running = events
    .filter((event) => event?.data?.running === true)
    .map((event) => describe(event, now))
    .sort((a, b) => a.id - b.id);
  if (running.length === 0) {
    return {
      bucket: bucketId,
      running_count: 0,
      running: "0 running timers",
    };
  }
  return {
    bucket: bucketId,
    running_count: running.length,
    running,
    help: ["Run `aw-axi timer stop --label <label> --base-url <url> --state <dir>` to stop one timer."],
  };
}

export async function timerStart(flags, client) {
  const label = requireLabel(flags.label);
  const now = nowFrom(flags);
  const stateDir = stateDirFrom(flags);
  return withLock(stateDir, "timer", async () => {
    const bucketId = await resolveStopwatchBucket(client, flags.bucket, { create: true });
    const running = (await getEvents(client, bucketId)).filter(
      (event) => event?.data?.running === true && event?.data?.label === label,
    );
    if (running.length > 1) {
      throw new AxiError(
        `${running.length} timers labeled ${JSON.stringify(label)} are already running. No new interval was created.`,
        "AMBIGUOUS",
        running.map((event) => `id ${event.id}`),
      );
    }
    if (running.length === 1) {
      return {
        result: "no-op",
        bucket: bucketId,
        id: running[0].id,
        label,
        running: true,
      };
    }
    const saved = await postEvents(client, bucketId, [
      {
        timestamp: now.toISOString(),
        duration: 0,
        data: { label, running: true },
      },
    ]);
    return {
      result: "started",
      bucket: bucketId,
      id: saved[0].id,
      label,
      running: true,
      started: acknowledgedTimestamp(saved[0], now),
    };
  });
}

export async function timerStop(flags, client) {
  const now = nowFrom(flags);
  const stateDir = stateDirFrom(flags);
  const label = flags.label === undefined ? undefined : requireLabel(flags.label);
  const id = flags.id === undefined ? undefined : requireEventId(flags.id);
  if (label === undefined && id === undefined) {
    throw new AxiError("Pass --label or --id so an unrelated running timer is not stopped", "VALIDATION_ERROR");
  }
  return withLock(stateDir, "timer", async () => {
    const bucketId = await resolveStopwatchBucket(client, flags.bucket);
    if (!bucketId) {
      return { result: "no-op", bucket: null, label: label ?? null, id: id ?? null, running: false };
    }
    const events = await getEvents(client, bucketId, { replay: true });
    const target = selectStopTarget(events, { label, id });
    if (target.kind === "absent") {
      return {
        result: "no-op",
        bucket: bucketId,
        label: label ?? null,
        id: id ?? null,
        running: false,
      };
    }
    if (target.kind === "ambiguous") throw target.error;
    const event = target.event;
    if (event.data?.running !== true) {
      return {
        result: "no-op",
        bucket: bucketId,
        id: event.id,
        label: event.data?.label ?? null,
        running: false,
      };
    }
    assertStopwatchReplay(event);
    const started = Date.parse(event.timestamp);
    const elapsed = now.getTime() - started;
    if (!Number.isFinite(started) || elapsed < 0) {
      throw new AxiError(
        `Event ${event.id} starts after --now, so it was not rewritten with a negative duration.`,
        "VALIDATION_ERROR",
      );
    }
    const next = {
      id: event.id,
      timestamp: event.timestamp,
      duration: secondsFromMs(elapsed),
      data: { ...event.data, running: false },
    };
    const saved = await postEvents(client, bucketId, [next]);
    if (saved[0].id !== event.id) {
      throw new AxiError(
        `The stop response id was ${saved[0].id}, not the event ${event.id} that was sent. No further event was written.`,
        "UNCERTAIN_WRITE",
        ["Run `aw-axi timer status --base-url <url>` and compare ids before another stop."],
      );
    }
    return {
      result: "stopped",
      bucket: bucketId,
      id: event.id,
      label: event.data?.label ?? null,
      running: false,
      duration_seconds: next.duration,
    };
  });
}

export async function timerSwitch(flags, client) {
  const to = requireLabel(flags.to);
  const from = flags.from === undefined ? undefined : requireLabel(flags.from);
  const now = nowFrom(flags);
  const stateDir = stateDirFrom(flags);
  return withLock(stateDir, "timer", async () => {
    const bucketId = await resolveStopwatchBucket(client, flags.bucket, { create: true });
    const events = await getEvents(client, bucketId, { replay: true });
    const running = events.filter((event) => event?.data?.running === true);
    let source = null;
    if (from !== undefined) {
      const matches = running.filter((event) => event.data?.label === from);
      if (matches.length > 1) {
        throw new AxiError(
          `${matches.length} running timers match --from. None were stopped and the next interval was not started.`,
          "AMBIGUOUS",
          matches.map((event) => `id ${event.id}`),
        );
      }
      source = matches[0] ?? null;
    } else if (running.length === 1) {
      source = running[0];
    } else if (running.length > 1) {
      throw new AxiError(
        `${running.length} timers are running. Pass --from. None were stopped and no interval was started.`,
        "AMBIGUOUS",
      );
    }
    if (source && source.data?.label === to) {
      const others = running.filter((event) => event.id !== source.id).length;
      return {
        result: "no-op",
        bucket: bucketId,
        id: source.id,
        label: to,
        running: true,
        other_running: others,
      };
    }
    const already = running.filter((event) => event.data?.label === to && event.id !== source?.id);
    if (already.length > 1) {
      throw new AxiError(
        `${already.length} timers labeled ${JSON.stringify(to)} are already running. Nothing was stopped or started.`,
        "AMBIGUOUS",
        already.map((event) => `id ${event.id}`),
      );
    }
    let stoppedId = null;
    if (source) {
      assertStopwatchReplay(source);
      const started = Date.parse(source.timestamp);
      const elapsed = now.getTime() - started;
      if (!Number.isFinite(started) || elapsed < 0) {
        throw new AxiError(
          `Event ${source.id} starts after --now. The switch made no write.`,
          "VALIDATION_ERROR",
        );
      }
      const saved = await postEvents(client, bucketId, [
        {
          id: source.id,
          timestamp: source.timestamp,
          duration: secondsFromMs(elapsed),
          data: { ...source.data, running: false },
        },
      ]);
      if (saved[0].id !== source.id) {
        throw new AxiError(
          `The stop response id was ${saved[0].id}, not ${source.id}. The next interval was not started and no further event was written.`,
          "PARTIAL",
          ["Run `aw-axi timer status --base-url <url>` before starting the next label."],
        );
      }
      stoppedId = source.id;
    }
    if (already.length === 1) {
      return {
        result: stoppedId === null ? "no-op" : "switched",
        bucket: bucketId,
        stopped_id: stoppedId,
        id: already[0].id,
        label: to,
        running: true,
        started: "already-running",
        server_transaction: "unsupported",
      };
    }
    try {
      const saved = await postEvents(client, bucketId, [
        {
          timestamp: now.toISOString(),
          duration: 0,
          data: { label: to, running: true },
        },
      ]);
      return {
        result: "switched",
        bucket: bucketId,
        stopped_id: stoppedId,
        id: saved[0].id,
        label: to,
        running: true,
        server_transaction: "unsupported",
      };
    } catch (error) {
      if (stoppedId === null) throw error;
      throw new AxiError(
        `Partial switch: stopped event ${stoppedId} and did not confirm the next interval. ${error.message}`,
        "PARTIAL",
        [
          "Run `aw-axi timer status --base-url <url>` before `aw-axi timer start --label <label>`.",
          "The two writes are separate. ActivityWatch does not provide one transaction for them.",
        ],
      );
    }
  });
}

function selectStopTarget(events, { label, id }) {
  if (id !== undefined) {
    const event = events.find((item) => item.id === id);
    if (!event) return { kind: "absent" };
    if (label !== undefined && event.data?.label !== label) {
      return {
        kind: "ambiguous",
        error: new AxiError(
          `--id ${id} is labeled ${JSON.stringify(event.data?.label ?? "")}, not ${JSON.stringify(label)}. It was not changed.`,
          "AMBIGUOUS",
        ),
      };
    }
    return { kind: "one", event };
  }
  const matches = events.filter((event) => event?.data?.running === true && event?.data?.label === label);
  if (matches.length === 0) return { kind: "absent" };
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      error: new AxiError(
        `${matches.length} running timers match this label. None were stopped.`,
        "AMBIGUOUS",
        ["Pass --id with the event to stop.", ...matches.map((event) => `id ${event.id}`)],
      ),
    };
  }
  return { kind: "one", event: matches[0] };
}

function describe(event, now) {
  const started = Date.parse(event.timestamp);
  const elapsed = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : 0;
  return {
    id: event.id,
    label: event.data?.label ?? "",
    state: "running",
    elapsed_seconds: secondsFromMs(elapsed),
  };
}

export async function countRunning(client) {
  const bucketId = await resolveStopwatchBucket(client);
  if (!bucketId) return { bucket: null, running_count: 0 };
  const events = await getEvents(client, bucketId);
  return {
    bucket: bucketId,
    running_count: events.filter((event) => event?.data?.running === true).length,
  };
}
