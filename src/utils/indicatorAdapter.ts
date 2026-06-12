import type {
  UserIndicatorDefinition,
  UserIndicatorInput,
  UserIndicatorResult,
  UserIndicatorSeries,
  UserIndicatorPoint,
  NormalizedUserIndicator,
} from '../types/indicator';
import type { Kline } from '../types/stock';
import { calculateSMA, calculateBollingerBands, calculateMACD } from './indicators';
import type {
  IndicatorCache,
  IndicatorData,
  IndicatorSeries,
  StrategyParamValue,
} from '../types/strategy';

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

/**
 * Builds an IndicatorCache from selected indicator definitions
 * for the current klines slice.
 */
export function buildIndicatorCache(
  definitions: readonly UserIndicatorDefinition[],
  symbol: string,
  klines: readonly Kline[],
): IndicatorCache {
  const byId: Record<string, IndicatorData> = {};

  for (const def of definitions) {
    const input = createIndicatorInput(klines, symbol, def);
    const normalized = calculateUserIndicatorSafely(def, input);

    const series: IndicatorSeries[] = normalized.result.series.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      data: s.data.map(p => ({
        time: p.time,
        value: p.value,
      })),
    }));

    byId[def.id] = {
      id: def.id,
      name: def.name,
      series,
    };
  }

  return { byId } as IndicatorCache;
}

/**
 * Computes flat indicator key-value pairs for the current kline index.
 * Merges built-in (MA5, MA10, MA20, MA60, BOLL, MACD) and user-defined
 * indicator values into a single flat record.
 */
export function computeIndicatorValues(
  definitions: readonly UserIndicatorDefinition[],
  symbol: string,
  klines: readonly Kline[],
  currentIndex: number,
): Record<string, StrategyParamValue> {
  const values: Record<string, StrategyParamValue> = {};
  const mutableKlines = [...klines];

  // Built-in: SMA moving averages
  const maPeriods = [5, 10, 20, 60];
  for (const period of maPeriods) {
    if (currentIndex >= period - 1) {
      const ma = calculateSMA(mutableKlines, period);
      const val = ma[currentIndex];
      if (val !== null) {
        values[`MA${period}`] = val;
      }
    }
  }

  // Built-in: Bollinger Bands (default period 20, multiplier 2)
  if (currentIndex >= 19) {
    const boll = calculateBollingerBands(mutableKlines);
    if (boll.upper[currentIndex] !== null) {
      values['BOLL_UP'] = boll.upper[currentIndex]!;
      values['BOLL_MID'] = boll.middle[currentIndex]!;
      values['BOLL_LOW'] = boll.lower[currentIndex]!;
    }
  }

  // Built-in: MACD (default 12, 26, 9)
  if (currentIndex >= 25) {
    const macd = calculateMACD(mutableKlines);
    if (macd.dif[currentIndex] !== null) {
      values['MACD_DIF'] = parseFloat(macd.dif[currentIndex]!.toFixed(4));
      values['MACD_DEA'] = parseFloat(macd.dea[currentIndex]!.toFixed(4));
      values['MACD'] = parseFloat(macd.histogram[currentIndex]!.toFixed(4));
    }
  }

  // User-defined indicators: use each series name as the key
  const currentDate = klines[currentIndex].date;
  for (const def of definitions) {
    const input = createIndicatorInput(klines, symbol, def);
    const normalized = calculateUserIndicatorSafely(def, input);
    for (const series of normalized.result.series) {
      const point = series.data.find(p => p.time === currentDate);
      if (point && point.value !== null) {
        values[series.name] = parseFloat(point.value.toFixed(4));
      }
    }
  }

  return values;
}
