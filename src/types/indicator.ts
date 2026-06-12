import type { Kline } from './stock';

/**
 * Timeframe for indicator calculation
 */
export type IndicatorTimeframe = 'daily';

/**
 * Allowed parameter value types
 */
export type IndicatorParamValue = string | number | boolean;

/**
 * Input passed to user-defined indicator calculation function
 */
export interface UserIndicatorInput {
  /** K-line data sorted from oldest to newest */
  klines: readonly Kline[];
  /** Stock symbol */
  symbol: string;
  /** Timeframe (currently only 'daily' is supported) */
  timeframe: IndicatorTimeframe;
  /** Resolved parameter values with defaults applied */
  params: Readonly<Record<string, IndicatorParamValue>>;
}

/**
 * Result returned from user-defined indicator calculation
 */
export interface UserIndicatorResult {
  /** Chart series data (line, histogram, etc.) */
  series: readonly UserIndicatorSeries[];
  /** Optional signal markers on candlesticks */
  signals?: readonly UserIndicatorSignal[];
  /** Optional hover panel field definitions */
  fields?: readonly UserIndicatorField[];
  /** Optional warnings (shown in console/dev tools) */
  warnings?: readonly string[];
}

/**
 * Base interface for all series types
 */
export interface BaseUserIndicatorSeries {
  /** Unique identifier within this indicator's result */
  id: string;
  /** Display name for the series */
  name: string;
  /** Which pane to render on: 'price' for main chart, 'indicator' for lower pane */
  pane: 'price' | 'indicator';
  /** Data points for the series */
  data: readonly UserIndicatorPoint[];
}

/**
 * Line series (e.g., moving average, trend line)
 */
export interface UserIndicatorLineSeries extends BaseUserIndicatorSeries {
  type: 'line';
  /** Line color (CSS color string) */
  color: string;
  /** Line width (1-4) */
  lineWidth?: 1 | 2 | 3 | 4;
  /** Line style */
  lineStyle?: 'solid' | 'dotted' | 'dashed';
}

/**
 * Histogram series (e.g., volume bars, MACD histogram)
 */
export interface UserIndicatorHistogramSeries extends BaseUserIndicatorSeries {
  type: 'histogram';
  /** Default color for all bars */
  color?: string;
  /** Color for positive values */
  positiveColor?: string;
  /** Color for negative values */
  negativeColor?: string;
  /** Base value for histogram (default: 0) */
  baseValue?: number;
}

/**
 * Union type for all series types
 */
export type UserIndicatorSeries =
  | UserIndicatorLineSeries
  | UserIndicatorHistogramSeries;

/**
 * Single data point in a series
 */
export interface UserIndicatorPoint {
  /** Date string matching Kline.date format */
  time: string;
  /** Value at this time (null = gap/no data) */
  value: number | null;
  /** Optional color override for this point */
  color?: string;
}

/**
 * Signal marker on candlestick
 */
export interface UserIndicatorSignal {
  /** Date string matching Kline.date format */
  time: string;
  /** Marker position relative to bar */
  position: 'aboveBar' | 'belowBar' | 'inBar';
  /** Marker shape */
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  /** Marker color */
  color: string;
  /** Optional text label */
  text?: string;
}

/**
 * Hover panel field definition
 */
export interface UserIndicatorField {
  /** Unique key for this field */
  key: string;
  /** Display label */
  label: string;
  /** ID of the series to pull value from */
  sourceSeriesId: string;
  /** Decimal precision for formatting */
  precision?: number;
  /** Optional color for the value display */
  color?: string;
}

/**
 * Parameter definition for user-configurable indicator parameters
 */
export interface UserIndicatorParamDefinition {
  /** Parameter key (used in params object) */
  key: string;
  /** Display label */
  label: string;
  /** Parameter type */
  type: 'number' | 'string' | 'boolean';
  /** Default value */
  defaultValue: IndicatorParamValue;
  /** Minimum value (for number type) */
  min?: number;
  /** Maximum value (for number type) */
  max?: number;
  /** Step increment (for number type) */
  step?: number;
}

/**
 * User-defined indicator calculation function signature
 */
export type UserIndicatorFunction = (
  input: UserIndicatorInput
) => UserIndicatorResult;

/**
 * Complete definition of a user-defined indicator
 */
export interface UserIndicatorDefinition {
  /** Unique identifier (lowercase kebab-case) */
  id: string;
  /** Short display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Whether to show by default */
  defaultVisible?: boolean;
  /** Parameter definitions */
  params?: readonly UserIndicatorParamDefinition[];
  /** Calculation function */
  calculate: UserIndicatorFunction;
}

/**
 * Normalized indicator result with error handling
 */
export interface NormalizedUserIndicator {
  /** Original indicator definition */
  definition: UserIndicatorDefinition;
  /** Normalized result (or empty result if errors) */
  result: UserIndicatorResult;
  /** Validation/normalization errors */
  errors: readonly string[];
}

/**
 * Stored indicator in local storage
 */
export interface StoredIndicator {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Full TypeScript source code */
  code: string;
  /** The user's natural-language prompt that generated this indicator */
  prompt?: string;
  /** The AI model used for generation */
  model?: string;
  /** Creation timestamp (ISO string) */
  createdAt: string;
  /** Last update timestamp (ISO string) */
  updatedAt: string;
  /** Whether to show by default */
  defaultVisible?: boolean;
  /** Parameter definitions */
  params?: readonly UserIndicatorParamDefinition[];
}

/**
 * Local storage data structure
 */
export interface IndicatorStorageData {
  /** Storage format version */
  version: number;
  /** Stored indicators */
  indicators: StoredIndicator[];
}

/**
 * Request for AI-assisted indicator generation
 */
export interface IndicatorDialogRequest {
  /** User's natural language description of the indicator */
  userDescription: string;
  /** Optional context for generation */
  context?: {
    symbol?: string;
    existingIndicatorIds?: readonly string[];
    preferredOutputType?: 'line' | 'histogram' | 'signal';
  };
}

/**
 * Response from AI-assisted indicator generation
 */
export interface IndicatorDialogResponse {
  /** Whether generation succeeded */
  success: boolean;
  /** Generated indicator definition (if successful) */
  indicator?: UserIndicatorDefinition;
  /** Generated TypeScript code (if successful) */
  code?: string;
  /** Explanation of the generated indicator */
  explanation?: string;
  /** Errors (if unsuccessful) */
  errors?: readonly string[];
  /** Suggestions for improvement */
  suggestions?: readonly string[];
  /** Whether saved to local storage */
  savedToStorage?: boolean;
  /** Storage ID if saved */
  storageId?: string;
}
