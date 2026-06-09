import type {
  UserIndicatorDefinition,
  UserIndicatorInput,
  UserIndicatorResult,
  UserIndicatorSeries,
  UserIndicatorPoint,
  NormalizedUserIndicator,
} from '../types/indicator';
import type { Kline } from '../types/stock';

/**
 * Validates and normalizes a numeric value
 * Returns null if the value is invalid (NaN, Infinity, -Infinity)
 */
function normalizeValue(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * Validates a date string exists in the K-line data
 */
function isValidDate(date: string, klineDates: Set<string>): boolean {
  return klineDates.has(date);
}

/**
 * Normalizes a single data point
 * Returns null if the point should be dropped
 */
function normalizePoint(
  point: UserIndicatorPoint,
  klineDates: Set<string>,
  errors: string[]
): UserIndicatorPoint | null {
  // Check if date exists in K-line data
  if (!isValidDate(point.time, klineDates)) {
    errors.push(`Unknown date "${point.time}" - point dropped`);
    return null;
  }

  // Normalize value
  const normalizedValue = normalizeValue(point.value);
  if (point.value !== null && normalizedValue === null) {
    errors.push(
      `Invalid numeric value at ${point.time}: ${point.value} - point dropped`
    );
    return null;
  }

  return {
    time: point.time,
    value: normalizedValue,
    color: point.color,
  };
}

/**
 * Normalizes series data
 * - Removes points with unknown dates
 * - Removes points with invalid numeric values (NaN, Infinity)
 * - Deduplicates points by keeping the last point for each date
 * - Sorts points to match K-line order
 */
function normalizeSeries(
  series: UserIndicatorSeries,
  klineDates: Set<string>,
  dateOrder: Map<string, number>,
  errors: string[]
): UserIndicatorSeries {
  // Normalize and filter points
  const normalizedPoints: UserIndicatorPoint[] = [];
  const seenDates = new Map<string, UserIndicatorPoint>();

  for (const point of series.data) {
    const normalized = normalizePoint(point, klineDates, errors);
    if (normalized !== null) {
      // Keep last point for each date (deduplication)
      seenDates.set(normalized.time, normalized);
    }
  }

  // Sort by K-line date order
  const sortedPoints = Array.from(seenDates.values()).sort((a, b) => {
    const orderA = dateOrder.get(a.time) ?? 0;
    const orderB = dateOrder.get(b.time) ?? 0;
    return orderA - orderB;
  });

  return {
    ...series,
    data: sortedPoints,
  };
}

/**
 * Validates series IDs are unique within an indicator result
 */
function validateSeriesIds(
  result: UserIndicatorResult,
  errors: string[]
): void {
  const ids = new Set<string>();
  for (const series of result.series) {
    if (ids.has(series.id)) {
      errors.push(`Duplicate series ID "${series.id}" in indicator result`);
    }
    ids.add(series.id);
  }
}

/**
 * Creates an empty indicator result
 */
function createEmptyResult(): UserIndicatorResult {
  return {
    series: [],
  };
}

/**
 * Safely calculates a user-defined indicator with validation and normalization
 * 
 * This function:
 * 1. Catches any errors thrown during calculation
 * 2. Validates the returned data structure
 * 3. Normalizes numeric values (rejects NaN, Infinity)
 * 4. Drops points with unknown dates
 * 5. Deduplicates points by keeping the last for each date
 * 6. Sorts points to match K-line order
 * 
 * @param definition - The indicator definition
 * @param input - The input data for calculation
 * @returns Normalized result with any errors encountered
 */
export function calculateUserIndicatorSafely(
  definition: UserIndicatorDefinition,
  input: UserIndicatorInput
): NormalizedUserIndicator {
  const errors: string[] = [];

  // Build date lookup structures
  const klineDates = new Set(input.klines.map(k => k.date));
  const dateOrder = new Map<string, number>();
  input.klines.forEach((k, i) => dateOrder.set(k.date, i));

  try {
    // Call the indicator calculation function
    const result = definition.calculate(input);

    // Validate result structure
    if (!result || typeof result !== 'object') {
      errors.push('Indicator returned invalid result (not an object)');
      return {
        definition,
        result: createEmptyResult(),
        errors,
      };
    }

    // Validate series array exists
    if (!Array.isArray(result.series)) {
      errors.push('Indicator result missing "series" array');
      return {
        definition,
        result: createEmptyResult(),
        errors,
      };
    }

    // Validate series IDs are unique
    validateSeriesIds(result, errors);

    // Normalize each series
    const normalizedSeries = result.series.map(series =>
      normalizeSeries(series, klineDates, dateOrder, errors)
    );

    // Normalize signals if present
    const normalizedSignals = result.signals
      ?.filter(signal => isValidDate(signal.time, klineDates))
      .map(signal => ({
        ...signal,
        time: signal.time,
      }));

    // Build normalized result
    const normalizedResult: UserIndicatorResult = {
      series: normalizedSeries,
      signals: normalizedSignals,
      fields: result.fields,
      warnings: result.warnings,
    };

    return {
      definition,
      result: normalizedResult,
      errors,
    };
  } catch (error) {
    // Catch calculation errors
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    errors.push(`Calculation error: ${errorMessage}`);

    return {
      definition,
      result: createEmptyResult(),
      errors,
    };
  }
}

/**
 * Builds parameter values with defaults applied
 */
export function buildIndicatorParams(
  definition: UserIndicatorDefinition,
  customParams?: Record<string, string | number | boolean>
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};

  // Apply default values from definition
  if (definition.params) {
    for (const paramDef of definition.params) {
      params[paramDef.key] = paramDef.defaultValue;
    }
  }

  // Override with custom values
  if (customParams) {
    Object.assign(params, customParams);
  }

  return params;
}

/**
 * Creates a UserIndicatorInput from K-line data
 */
export function createIndicatorInput(
  klines: readonly Kline[],
  symbol: string,
  definition: UserIndicatorDefinition,
  customParams?: Record<string, string | number | boolean>
): UserIndicatorInput {
  return {
    klines,
    symbol,
    timeframe: 'daily',
    params: buildIndicatorParams(definition, customParams),
  };
}

/**
 * Validates an indicator ID format
 * Must be lowercase kebab-case: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
 */
export function isValidIndicatorId(id: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id);
}
