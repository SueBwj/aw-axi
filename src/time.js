import { Temporal } from "temporal-polyfill";
import { AxiError } from "axi-sdk-js";

export function secondsFromMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new AxiError("A duration was negative or not a number", "SERVER");
  }
  const rounded = Math.round(ms);
  const whole = Math.floor(rounded / 1000);
  const frac = rounded % 1000;
  if (frac === 0) return whole;
  return Number(`${whole}.${String(frac).padStart(3, "0").replace(/0+$/, "")}`);
}

export function instantFromDate(date) {
  try {
    return Temporal.Instant.fromEpochMilliseconds(date.getTime());
  } catch (error) {
    throw timeRuntimeError(error);
  }
}

export function timeZoneFrom(flags) {
  let zone;
  try {
    zone = flags.timezone ?? Temporal.Now.timeZoneId();
  } catch (error) {
    throw timeRuntimeError(error);
  }
  try {
    Temporal.Now.instant().toZonedDateTimeISO(zone);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AxiError(`Unknown timezone \`${zone}\``, "VALIDATION_ERROR", [
        "Pass an IANA timezone such as Asia/Taipei or America/New_York",
      ]);
    }
    throw timeRuntimeError(error);
  }
  return zone;
}

function timeRuntimeError(error) {
  const name = error instanceof Error && error.name ? error.name : "unknown";
  throw new AxiError(
    `The time runtime failed (${name}). This is not an invalid timezone or local time.`,
    "SERVER",
    ["The timezone name was not the problem."],
  );
}

export function localToInstant(input, timeZone) {
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(input)) {
    throw new AxiError(
      `--start and --end are local times in --timezone, without an offset`,
      "VALIDATION_ERROR",
      ["Example: --start 2026-11-15T00:00:00 --timezone Asia/Taipei"],
    );
  }
  let plain;
  try {
    plain = /^\d{4}-\d{2}-\d{2}$/.test(input)
      ? Temporal.PlainDate.from(input).toPlainDateTime()
      : Temporal.PlainDateTime.from(input);
  } catch (error) {
    if (!(error instanceof RangeError)) throw timeRuntimeError(error);
    throw new AxiError(`Could not read local time \`${input}\``, "VALIDATION_ERROR", [
      "Use YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS",
    ]);
  }
  try {
    return plain.toZonedDateTime(timeZone, { disambiguation: "reject" }).toInstant();
  } catch (error) {
    if (!(error instanceof RangeError)) throw timeRuntimeError(error);
    throw new AxiError(
      `Local time ${input} does not occur exactly once in ${timeZone}`,
      "VALIDATION_ERROR",
      ["Choose a local time outside the DST overlap or gap"],
    );
  }
}

export function formatInstant(instant, timeZone) {
  return instant.toZonedDateTimeISO(timeZone).toString({ timeZoneName: "never" });
}

export function rangeFrom(flags, now, timeZone) {
  const hasStart = flags.start !== undefined;
  const hasEnd = flags.end !== undefined;
  if (hasStart !== hasEnd) {
    throw new AxiError("Pass both --start and --end, or neither", "VALIDATION_ERROR");
  }
  const nowInstant = instantFromDate(now);
  if (!hasStart) {
    const zoned = nowInstant.toZonedDateTimeISO(timeZone);
    return {
      start: zoned.subtract({ days: 7 }).toInstant(),
      end: zoned.toInstant(),
      timeZone,
      defaulted: true,
    };
  }
  const start = localToInstant(flags.start, timeZone);
  const end = localToInstant(flags.end, timeZone);
  if (end.epochMilliseconds <= start.epochMilliseconds) {
    throw new AxiError("--end must be after --start", "VALIDATION_ERROR");
  }
  return { start, end, timeZone, defaulted: false };
}

export function eventInterval(event, nowMs) {
  const start = Date.parse(event.timestamp);
  if (!Number.isFinite(start)) return null;
  if (event.data && event.data.running === true) {
    return { start, end: nowMs, running: true };
  }
  const durationMs = Number(event.duration) * 1000;
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  return { start, end: start + durationMs, running: false };
}

export function intersect(start, end, boundStart, boundEnd) {
  const lo = Math.max(start, boundStart);
  const hi = Math.min(end, boundEnd);
  if (hi <= lo) return null;
  return { start: lo, end: hi };
}

export function unionMs(intervals) {
  const sorted = intervals
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let sum = 0;
  let union = 0;
  let cursor = null;
  let mergedEnd = null;
  for (const interval of sorted) {
    sum += interval.end - interval.start;
    if (mergedEnd === null || interval.start > mergedEnd) {
      if (mergedEnd !== null) union += mergedEnd - cursor;
      cursor = interval.start;
      mergedEnd = interval.end;
    } else if (interval.end > mergedEnd) {
      mergedEnd = interval.end;
    }
  }
  if (mergedEnd !== null) union += mergedEnd - cursor;
  return { union, sum, overlap: sum - union };
}
