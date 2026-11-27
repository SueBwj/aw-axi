import { AxiError } from "axi-sdk-js";

export function decimalParts(source, { trimTrailingZeros = true } = {}) {
  const negative = source.startsWith("-");
  const [mantissa, power = "0"] = source.slice(negative ? 1 : 0).split(/[eE]/);
  const [integer, fraction = ""] = mantissa.split(".");
  const digits = (integer + fraction).replace(/^0+/, "");
  let end = digits.length;
  while (trimTrailingZeros && end > 0 && digits[end - 1] === "0") end -= 1;
  return {
    negative,
    digits: digits.slice(0, end) || "0",
    exponent: trimTrailingZeros && end === 0 ? 0 : Number(power) - fraction.length + digits.length - end,
  };
}

export function sameDecimal(source, encoded) {
  const original = decimalParts(source);
  const normalized = decimalParts(encoded);
  return original.negative === normalized.negative && original.digits === normalized.digits &&
    original.exponent === normalized.exponent;
}

export function numberReplaysExactly(value, source) {
  if (!Number.isFinite(value)) return false;
  const encoded = JSON.stringify(value);
  if (source === encoded) return true;
  if (!sameDecimal(source, encoded)) return false;
  if (!/[.eE]/.test(source)) return BigInt(source) === BigInt(value);
  if (!/[.e]/.test(encoded)) return BigInt(encoded) === BigInt(value);
  return true;
}

export function parseReplayJson(text, code) {
  return JSON.parse(text, (_, value, context) => {
    if (typeof value === "number" && !numberReplaysExactly(value, context.source)) {
      throw new AxiError("A JSON number cannot be replayed without rounding.", code);
    }
    return value;
  });
}
