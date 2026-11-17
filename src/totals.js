import { getEvents, resolveStopwatchBucket } from "./client.js";
import { nowFrom, requireLabel } from "./options.js";
import { eventInterval, formatInstant, rangeFrom, secondsFromMs, timeZoneFrom, unionMs } from "./time.js";

export async function taskTotals(flags, client) {
  const label = requireLabel(flags.label);
  const now = nowFrom(flags);
  const timeZone = timeZoneFrom(flags);
  const range = rangeFrom(flags, now, timeZone);
  const bucketId = await resolveStopwatchBucket(client, flags.bucket);
  const events = bucketId ? await getEvents(client, bucketId) : [];
  const nowMs = now.getTime();
  const startMs = range.start.epochMilliseconds;
  const endMs = range.end.epochMilliseconds;
  const matched = events.filter((event) => event?.data?.label === label);
  const completed = [];
  const running = [];
  let invalid = 0;
  for (const event of matched) {
    const interval = eventInterval(event, nowMs);
    if (!interval) {
      invalid += 1;
      continue;
    }
    const clippedStart = Math.max(interval.start, startMs);
    const clippedEnd = Math.min(interval.end, endMs);
    if (clippedEnd <= clippedStart) continue;
    const piece = { start: clippedStart, end: clippedEnd, id: event.id };
    if (interval.running) running.push(piece);
    else completed.push(piece);
  }
  const stored = unionMs(completed);
  const runningUnion = unionMs(running);
  return {
    label,
    bucket: bucketId,
    timezone: timeZone,
    start: formatInstant(range.start, timeZone),
    end: formatInstant(range.end, timeZone),
    end_exclusive: true,
    completed_seconds: secondsFromMs(stored.union),
    stored_sum_seconds: secondsFromMs(stored.sum),
    overlap_seconds: secondsFromMs(stored.overlap),
    running_elapsed_seconds: secondsFromMs(runningUnion.union),
    running_count: running.length,
    stopped_count: completed.length,
    invalid_events: invalid,
    overlap: stored.overlap === 0 ? "none" : "completed_seconds is the union; overlapping stored time is counted once",
    automatic_activity: "excluded",
  };
}
