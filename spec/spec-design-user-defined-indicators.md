---
title: User-Defined Indicator Interface and K-Line Chart Rendering
version: 1.0
date_created: 2026-06-09
last_updated: 2026-06-09
owner: Project maintainers
tags: [design, indicators, kline, lightweight-charts, ai-assisted-development]
---

# Introduction

This specification defines a stable TypeScript interface for user-defined technical indicators and the chart integration required to display those indicators on the K-line chart. The goal is to let a user or AI assistant implement an indicator calculation function with fixed input parameters and a fixed return shape, then register and render the indicator without editing the chart rendering logic for each new indicator.

## 1. Purpose & Scope

This specification applies to the React and TypeScript frontend of the ChanLun Stock Analyzer project.

The scope includes:

- A fixed, AI-friendly user-defined indicator function contract.
- Metadata required to register a user-defined indicator.
- Return data contracts for price overlays, lower-pane indicators, histogram series, and marker signals.
- Chart rendering behavior in `src/components/ChanlunChart.tsx`.
- Storage and discovery rules for source-controlled user-defined indicators.
- Validation, error handling, hover display, and acceptance criteria.

The scope excludes:

- Runtime execution of arbitrary code typed into a browser text area.
- Server-side indicator execution.
- Trading orders, alerts, broker integration, or investment advice.
- A full visual indicator editor.

Assumptions:

- K-line data uses the existing `Kline` interface from `src/types/stock.ts`.
- The chart uses `lightweight-charts`.
- User-defined means a developer, user, or AI assistant adds a TypeScript module to the project source and registers it.

## 2. Definitions

| Term | Definition |
| --- | --- |
| K-line | A market candle with date, open, high, low, close, volume, and amount fields. |
| K-line chart | The visual chart rendered by `ChanlunChart.tsx` using `lightweight-charts`. |
| Indicator | A deterministic calculation derived from the current K-line array and optional configured parameters. |
| Built-in indicator | An indicator already implemented in the app, such as MA5, MA20, Bollinger Bands, or MACD. |
| User-defined indicator | A source-controlled TypeScript indicator module implemented by a user or AI assistant using the fixed interface in this specification. |
| Stored indicator | A user-defined indicator saved to browser local storage for persistence across sessions. |
| Price overlay | A line or marker drawn on the same price scale as candlesticks. |
| Indicator pane | A lower chart area with its own price scale for non-price values such as oscillator or histogram output. |
| Series | A chart renderable output such as a line, histogram, or markers. |
| Signal marker | A marker attached to a K-line date, for example a buy, sell, warning, or neutral signal. |
| AI-assisted implementation | A workflow where an AI assistant receives the fixed interface, the user's indicator formula, and returns a TypeScript module that satisfies this specification. |
| Indicator dialog | A UI component where users describe indicator ideas in natural language and AI generates runnable code. |

## 3. Requirements, Constraints & Guidelines

- **REQ-001**: The project shall expose a user-defined indicator contract from `src/types/indicator.ts`.
- **REQ-002**: Every user-defined indicator shall implement exactly one fixed calculation signature: `calculate(input: UserIndicatorInput): UserIndicatorResult`.
- **REQ-003**: The calculation function shall be synchronous, deterministic, and side-effect free.
- **REQ-004**: The calculation function shall receive K-line data, symbol, timeframe, and parameter values through the `UserIndicatorInput` object only.
- **REQ-005**: The calculation function shall not receive chart instances, React state setters, DOM nodes, storage APIs, network clients, or rendering callbacks.
- **REQ-006**: The calculation function shall return only serializable data described by `UserIndicatorResult`.
- **REQ-007**: User-defined indicator modules shall export a `UserIndicatorDefinition`.
- **REQ-008**: User-defined indicators shall be registered in a single registry file so `ChanlunChart.tsx` can discover them without importing individual indicator modules.
- **REQ-009**: Each registered user-defined indicator shall appear in the indicator toggle controls.
- **REQ-010**: When a user-defined indicator is enabled, its returned series shall be rendered on the K-line chart.
- **REQ-011**: Price overlay series shall render on the candlestick price scale.
- **REQ-012**: Indicator pane series shall render on a dedicated lower price scale with scale margins that do not hide candlesticks.
- **REQ-013**: The hover details panel shall include enabled user-defined indicator values when the current crosshair date has matching data.
- **REQ-014**: The chart shall not crash when an indicator returns no data, null values, duplicate dates, unsupported dates, or invalid numbers.
- **REQ-015**: Indicator-specific errors shall be isolated to the failing indicator and shall not affect built-in indicators or chart rendering.
- **REQ-016**: User-defined indicators shall be disabled by default unless their definition sets `defaultVisible: true`.
- **REQ-017**: Indicator IDs shall be stable, unique, lowercase kebab-case strings.
- **REQ-018**: Parameter values shall come from metadata-defined defaults until future UI support allows users to edit them.
- **REQ-019**: The implementation shall support at least line series, histogram series, and signal markers.
- **REQ-020**: AI-assisted implementation prompts shall include the fixed interface and shall instruct the AI to return a complete TypeScript module, not edits to chart internals.
- **REQ-021**: Users shall be able to save generated indicator scripts to browser local storage.
- **REQ-022**: Saved indicators shall persist across browser sessions and be automatically loaded on app startup.
- **REQ-023**: The dialog UI shall provide actions to save, load, edit, delete, export, and import stored indicators.
- **REQ-024**: Stored indicators shall be validated before execution to ensure they conform to the contract.
- **REQ-025**: The storage system shall support versioned data format for future migrations.

- **CON-001**: Source-controlled user-defined indicators (in `src/indicators/user/`) shall run as normal TypeScript modules without `eval` or `new Function`.
- **CON-007**: Locally stored indicators may use `new Function` for runtime evaluation since the code is user-controlled and generated by AI following the contract.
- **CON-002**: Indicator output dates shall use the same date string format as `Kline.date`.
- **CON-003**: A returned point with `value: null` shall be treated as an intentional gap and shall not be passed to `lightweight-charts` as a numeric point.
- **CON-004**: A returned point with `NaN`, `Infinity`, or `-Infinity` shall be rejected during normalization.
- **CON-005**: The chart adapter shall preserve the existing built-in indicator behavior for MA5, MA20, Bollinger Bands, and MACD.
- **CON-006**: New code shall preserve TypeScript type safety and pass `npm run lint`.

- **GUD-001**: Put reusable indicator math helpers in `src/utils/indicators.ts` only when they are shared by more than one indicator.
- **GUD-002**: Put user-defined indicator modules under `src/indicators/user/`.
- **GUD-003**: Keep user-defined indicator logic pure. Given the same input, it should return the same output.
- **GUD-004**: Prefer one user-defined indicator per file.
- **GUD-005**: Keep display metadata close to the indicator definition so the chart registry can render it without special cases.

## 4. Interfaces & Data Contracts

### 4.1 Source File Layout

The implementation should introduce these files:

```text
src/types/indicator.ts
src/indicators/user/index.ts
src/indicators/user/*.ts
src/utils/indicatorAdapter.ts
src/utils/indicatorStorage.ts
src/utils/indicatorLoader.ts
src/components/IndicatorDialog.tsx
```

Responsibilities:

| File | Responsibility |
| --- | --- |
| `src/types/indicator.ts` | Owns the fixed user-defined indicator interfaces. |
| `src/indicators/user/index.ts` | Exports the registry of user-defined indicators. |
| `src/indicators/user/*.ts` | Contains individual user-defined indicator definitions. |
| `src/utils/indicatorAdapter.ts` | Validates, normalizes, and maps user-defined output to `lightweight-charts` data. |
| `src/utils/indicatorStorage.ts` | Manages local storage persistence for user indicators. |
| `src/utils/indicatorLoader.ts` | Loads and parses stored indicators at runtime. |
| `src/components/IndicatorDialog.tsx` | Dialog UI for AI-assisted indicator creation and storage management. |
| `src/components/ChanlunChart.tsx` | Creates chart series, toggles visibility, sets data, and displays hover values. |

### 4.2 Fixed Function Signature

Every user-defined indicator shall implement this exact calculation shape:

```ts
import type { Kline } from './stock';

export type IndicatorTimeframe = 'daily';

export type IndicatorParamValue = string | number | boolean;

export interface UserIndicatorInput {
  klines: readonly Kline[];
  symbol: string;
  timeframe: IndicatorTimeframe;
  params: Readonly<Record<string, IndicatorParamValue>>;
}

export type UserIndicatorFunction = (
  input: UserIndicatorInput
) => UserIndicatorResult;
```

Rules:

- `klines` shall be sorted from oldest to newest.
- `klines` shall be treated as immutable.
- `symbol` shall match the stock currently displayed by the chart.
- `timeframe` shall be `daily` until the app supports additional intervals.
- `params` shall include resolved parameter values after applying defaults.

### 4.3 Indicator Definition Contract

```ts
export interface UserIndicatorDefinition {
  id: string;
  name: string;
  description?: string;
  defaultVisible?: boolean;
  params?: readonly UserIndicatorParamDefinition[];
  calculate: UserIndicatorFunction;
}

export interface UserIndicatorParamDefinition {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean';
  defaultValue: IndicatorParamValue;
  min?: number;
  max?: number;
  step?: number;
}
```

Definition rules:

- `id` shall be unique across built-in and user-defined indicators.
- `id` shall match `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`.
- `name` shall be short enough to fit in existing chart toggle buttons.
- `params` shall define every parameter used by `calculate`.
- `calculate` shall not read missing parameters without applying a local fallback.

### 4.4 Result Contract

```ts
export interface UserIndicatorResult {
  series: readonly UserIndicatorSeries[];
  signals?: readonly UserIndicatorSignal[];
  fields?: readonly UserIndicatorField[];
  warnings?: readonly string[];
}

export type UserIndicatorSeries =
  | UserIndicatorLineSeries
  | UserIndicatorHistogramSeries;

export interface BaseUserIndicatorSeries {
  id: string;
  name: string;
  pane: 'price' | 'indicator';
  data: readonly UserIndicatorPoint[];
}

export interface UserIndicatorLineSeries extends BaseUserIndicatorSeries {
  type: 'line';
  color: string;
  lineWidth?: 1 | 2 | 3 | 4;
  lineStyle?: 'solid' | 'dotted' | 'dashed';
}

export interface UserIndicatorHistogramSeries extends BaseUserIndicatorSeries {
  type: 'histogram';
  color?: string;
  positiveColor?: string;
  negativeColor?: string;
  baseValue?: number;
}

export interface UserIndicatorPoint {
  time: string;
  value: number | null;
  color?: string;
}

export interface UserIndicatorSignal {
  time: string;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  color: string;
  text?: string;
}

export interface UserIndicatorField {
  key: string;
  label: string;
  sourceSeriesId: string;
  precision?: number;
  color?: string;
}
```

Result rules:

- `series` shall always be present. It may be an empty array.
- `series[].id` shall be unique within a single indicator result.
- `series[].data[].time` shall match a `Kline.date` value to appear on the chart.
- `series[].data[].value` may be `null` to represent a gap.
- `signals` shall be optional and shall render as markers on the candlestick series.
- `fields` shall be optional and shall describe which series values appear in the hover panel.
- `warnings` shall be optional and shall be displayed only in developer diagnostics or console output unless a future UI requires visible warnings.

### 4.5 Registry Contract

The registry shall export an array:

```ts
import type { UserIndicatorDefinition } from '../../types/indicator';

export const userIndicators: readonly UserIndicatorDefinition[] = [
  // Import and add user-defined indicators here
];
```

Registry rules:

- The registry shall validate duplicate IDs during development.
- The chart shall import only the registry, not individual user indicator files.
- Removing an indicator from the registry shall remove it from the UI.

### 4.6 Chart Adapter Contract

The chart adapter shall normalize user-defined output before `ChanlunChart.tsx` uses it.

```ts
export interface NormalizedUserIndicator {
  definition: UserIndicatorDefinition;
  result: UserIndicatorResult;
  errors: readonly string[];
}

export function calculateUserIndicatorSafely(
  definition: UserIndicatorDefinition,
  input: UserIndicatorInput
): NormalizedUserIndicator;
```

Adapter rules:

- Catch calculation errors.
- Reject invalid numbers.
- Drop points with unknown dates.
- Sort points to match K-line order.
- Drop duplicate points by keeping the last point for a date and series.
- Return errors instead of throwing to React render code.

## 5. Acceptance Criteria

- **AC-001**: Given a user-defined indicator module that satisfies `UserIndicatorDefinition`, When it is exported from `src/indicators/user/index.ts`, Then the chart displays a toggle for that indicator.
- **AC-002**: Given the indicator toggle is enabled, When the indicator returns a price line series, Then the line appears on the same price scale as the candlestick chart.
- **AC-003**: Given the indicator toggle is enabled, When the indicator returns an indicator-pane histogram series, Then the histogram appears in a lower chart area and the candlesticks remain visible.
- **AC-004**: Given the crosshair is over a K-line date with user-defined indicator values, When the indicator defines hover `fields`, Then the hover panel displays the matching labels and formatted values.
- **AC-005**: Given an indicator returns `null` values, When the chart renders the series, Then gaps are omitted without crashing.
- **AC-006**: Given an indicator throws during calculation, When the chart renders, Then the chart still renders candlesticks and built-in indicators, and the failed user indicator is skipped.
- **AC-007**: Given two indicators use the same ID, When the registry is loaded in development, Then a duplicate ID warning or error is produced.
- **AC-008**: Given `npm run lint` is executed after implementation, Then TypeScript completes without errors.
- **AC-009**: Given an AI assistant receives the interface and a formula request, When it creates a user-defined indicator module, Then no edits to `ChanlunChart.tsx` are required beyond the generic chart integration already implemented.
- **AC-010**: Given a user saves an indicator through the dialog, When the save action completes, Then the indicator is stored in local storage and appears in the chart toggle controls.
- **AC-011**: Given the app restarts, When stored indicators exist in local storage, Then they are automatically loaded and available in the chart without user action.
- **AC-012**: Given a user deletes a stored indicator, When the delete action completes, Then the indicator is removed from local storage and the chart toggle controls.
- **AC-013**: Given a user exports indicators, When the export action completes, Then a JSON file containing all stored indicators is downloaded.
- **AC-014**: Given a user imports a valid indicator JSON file, When the import action completes, Then the indicators are added to local storage and available in the chart.
- **AC-015**: Given a stored indicator has invalid code, When the app loads, Then the indicator is skipped with a console warning and does not crash the app.

## 6. Test Automation Strategy

- **Test Levels**: Type checks, unit tests for pure indicator calculations, adapter tests, and focused component tests if a React test framework is added.
- **Frameworks**: The current project has TypeScript checking through `npm run lint`. Future unit tests may use Vitest and React Testing Library.
- **Test Data Management**: Use small inline K-line arrays with 5 to 30 candles. Include rising, falling, flat, and missing-value scenarios where applicable.
- **CI/CD Integration**: Run `npm run lint` in CI. Add unit test command when a test runner exists.
- **Coverage Requirements**: Indicator adapter edge cases shall be covered before accepting arbitrary user-defined indicators in the registry.
- **Performance Testing**: A user-defined indicator should complete within 50 ms for 2,000 K-lines on a typical development machine. Expensive indicators should cache intermediate values inside the pure calculation scope only.

Minimum test cases:

- Valid line output maps to `LineData<Time>[]`.
- Valid histogram output maps to `HistogramData<Time>[]`.
- Unknown dates are dropped.
- Duplicate dates keep the last value.
- `NaN`, `Infinity`, and `-Infinity` values are dropped.
- Thrown calculation errors are converted to adapter errors.
- Empty K-line input returns empty chart data.
- Stored indicator save and load round-trip correctly.
- Invalid stored indicator code is skipped gracefully.
- Storage version migration preserves existing indicators.
- Export and import preserves all indicator data.

## 7. Rationale & Context

The current chart implementation computes built-in indicators directly in `ChanlunChart.tsx` and `src/utils/indicators.ts`. This works for a small fixed set of indicators but does not scale well when users want to add custom formulas. A fixed interface gives AI assistants enough context to generate safe, focused TypeScript modules without requiring them to understand the full chart component.

The design keeps calculation and rendering separate:

- User-defined indicator modules calculate serializable output.
- The registry discovers indicator definitions.
- The adapter validates and normalizes results.
- `ChanlunChart.tsx` handles chart series creation, visibility, and hover display.

This separation prevents each new indicator from creating new chart-specific branches and reduces the chance that AI-assisted code changes break existing chart behavior.

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**: None required for calculation. User-defined indicators shall use the current in-memory K-line data only.

### Third-Party Services

- **SVC-001**: Optional AI assistant used outside the runtime app to generate TypeScript code from the fixed interface and user formula. No runtime dependency is required.

### Infrastructure Dependencies

- **INF-001**: Browser runtime capable of running the existing React and Vite bundle.

### Data Dependencies

- **DAT-001**: K-line array from the existing app data flow. Required fields are `date`, `open`, `high`, `low`, `close`, `volume`, and `amount`.

### Technology Platform Dependencies

- **PLT-001**: React and TypeScript frontend.
- **PLT-002**: `lightweight-charts` for chart rendering.
- **PLT-003**: Vite build pipeline for bundling user-defined indicator modules.

### Compliance Dependencies

- **COM-001**: User-defined indicators are for educational and research use only and shall not represent financial advice.

## 9. Examples & Edge Cases

### 9.1 AI-Assisted Implementation Prompt Template

Use this prompt when asking an AI assistant to create a new user-defined indicator:

```text
Create a TypeScript user-defined indicator for ChanLun Stock Analyzer.

You must return one complete module that exports a UserIndicatorDefinition.
Do not edit chart code.
Do not use network requests, DOM APIs, localStorage, eval, new Function, or async code.
Use only the fixed calculate(input: UserIndicatorInput): UserIndicatorResult contract.

Indicator formula:
[Describe the formula here.]

Available Kline fields:
- date: string
- open: number
- high: number
- low: number
- close: number
- volume: number
- amount: number

Expected visual output:
[Describe line, histogram, marker, price overlay, or lower-pane output.]
```

### 9.2 AI-Assisted Dialog Workflow

The AI-assisted dialog workflow allows users to describe indicator ideas in natural language, and the AI converts them into runnable TypeScript modules that conform to the `UserIndicatorDefinition` contract.

#### 9.2.1 Dialog Interface

```ts
export interface IndicatorDialogRequest {
  userDescription: string;
  context?: {
    symbol?: string;
    existingIndicatorIds?: readonly string[];
    preferredOutputType?: 'line' | 'histogram' | 'signal';
  };
}

export interface IndicatorDialogResponse {
  success: boolean;
  indicator?: UserIndicatorDefinition;
  code?: string;
  explanation?: string;
  errors?: readonly string[];
  suggestions?: readonly string[];
}
```

#### 9.2.2 Dialog Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     User Dialog Interface                        │
├─────────────────────────────────────────────────────────────────┤
│  User Input (Natural Language):                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ "我想创建一个指标，显示当收盘价上穿MA20时标记买入信号，        ││
│  │  下穿MA20时标记卖出信号"                                     ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  AI Processing:                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 1. Parse natural language description                        ││
│  │ 2. Identify indicator type (signal, line, histogram)         ││
│  │ 3. Extract formula logic and parameters                      ││
│  │ 4. Generate TypeScript module conforming to contract         ││
│  │ 5. Validate against UserIndicatorDefinition interface        ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  AI Output (Runnable Contract):                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Generated TypeScript code + explanation + suggestions        ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

#### 9.2.3 Dialog Prompt Template

When a user submits their indicator idea, the AI receives this prompt structure:

```text
You are an indicator code generator for ChanLun Stock Analyzer.

CONTRACT REQUIREMENTS:
- Export exactly one UserIndicatorDefinition
- Implement calculate(input: UserIndicatorInput): UserIndicatorResult
- No network requests, DOM APIs, localStorage, eval, new Function, or async
- Pure, synchronous, deterministic calculation

AVAILABLE INPUT:
- klines: readonly Kline[] (sorted oldest to newest)
- symbol: string
- timeframe: 'daily'
- params: Record<string, string | number | boolean>

KLINE FIELDS:
- date: string
- open: number
- high: number
- low: number
- close: number
- volume: number
- amount: number

OUTPUT OPTIONS:
1. Line series (price overlay or indicator pane)
2. Histogram series (indicator pane)
3. Signal markers (aboveBar, belowBar, inBar)

USER'S INDICATOR IDEA:
{userDescription}

Generate a complete TypeScript module that exports UserIndicatorDefinition.
Include helpful parameter definitions if the formula uses configurable values.
Add a clear description explaining what the indicator shows.
```

#### 9.2.4 Example Dialog Sessions

**Session 1: Simple Moving Average Crossover Signal**

```
User: "创建一个MA5上穿MA10的买入信号指标"

AI Response:
┌─────────────────────────────────────────────────────────────────┐
│ ✅ Indicator Generated: ma5-cross-ma10-signal                   │
│                                                                  │
│ 📝 Explanation:                                                  │
│ This indicator marks buy signals when MA5 crosses above MA10,   │
│ and sell signals when MA5 crosses below MA10.                   │
│                                                                  │
│ 📄 Generated Code:                                               │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ // src/indicators/user/ma5-cross-ma10-signal.ts             │ │
│ │ import type { UserIndicatorDefinition } from '../../types'; │ │
│ │                                                              │ │
│ │ export const ma5CrossMa10Signal: UserIndicatorDefinition = {│ │
│ │   id: 'ma5-cross-ma10-signal',                              │ │
│ │   name: 'MA5×MA10',                                         │ │
│ │   description: 'MA5/MA10 crossover signals',                │ │
│ │   // ... full implementation                                 │ │
│ │ };                                                           │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ 💡 Suggestions:                                                  │
│ - Consider adding a parameter for MA periods                     │
│ - You may want to add the MA lines as overlay series             │
└─────────────────────────────────────────────────────────────────┘
```

**Session 2: Custom Oscillator**

```
User: "我想看成交量加权价格偏离度，计算 (close - VWAP) / close * 100，显示在副图"

AI Response:
┌─────────────────────────────────────────────────────────────────┐
│ ✅ Indicator Generated: vwap-deviation                          │
│                                                                  │
│ 📝 Explanation:                                                  │
│ Volume-Weighted Average Price deviation shows how much the      │
│ current price deviates from VWAP as a percentage.               │
│ Positive values indicate price above VWAP, negative below.      │
│                                                                  │
│ 📄 Generated Code: [TypeScript module...]                       │
│                                                                  │
│ 💡 Suggestions:                                                  │
│ - Added zero line for reference                                  │
│ - Consider adding overbought/oversold thresholds                │
└─────────────────────────────────────────────────────────────────┘
```

#### 9.2.5 AI Validation Checklist

Before returning the generated indicator, AI must verify:

| Check | Description |
|-------|-------------|
| ✅ Interface conformance | Output matches UserIndicatorDefinition |
| ✅ Unique ID | ID does not conflict with existing indicators |
| ✅ Valid ID format | Matches `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/` |
| ✅ No forbidden APIs | No network, DOM, eval, async, or side effects |
| ✅ Serializable output | All return values are JSON-serializable |
| ✅ Parameter coverage | All params used in calculate are defined |
| ✅ Type safety | Code passes TypeScript compilation |

#### 9.2.6 Error Handling in Dialog

```ts
// Example error response
{
  success: false,
  errors: [
    "Cannot use async/await in indicator calculation",
    "ID 'my-indicator' conflicts with existing indicator"
  ],
  suggestions: [
    "Remove async keyword from calculate function",
    "Use a different ID like 'my-custom-indicator'"
  ]
}
```

#### 9.2.7 Local Storage Persistence

Users can save their generated indicator scripts to browser local storage and reuse them in future sessions without re-generating.

##### Storage Interface

```ts
export interface StoredIndicator {
  id: string;
  name: string;
  description?: string;
  code: string;                    // Full TypeScript source code
  createdAt: string;               // ISO timestamp
  updatedAt: string;               // ISO timestamp
  defaultVisible?: boolean;
  params?: readonly UserIndicatorParamDefinition[];
}

export interface IndicatorStorage {
  getAll(): StoredIndicator[];
  get(id: string): StoredIndicator | null;
  save(indicator: StoredIndicator): void;
  delete(id: string): void;
  exportAll(): string;             // JSON export
  importAll(json: string): void;   // JSON import
}
```

##### Storage Key

```ts
const STORAGE_KEY = 'chanlun-user-indicators';
const STORAGE_VERSION = 1;
```

##### Storage Operations

```ts
// src/utils/indicatorStorage.ts

export const indicatorStorage: IndicatorStorage = {
  getAll(): StoredIndicator[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      // Version migration if needed
      return data.indicators || [];
    } catch {
      return [];
    }
  },

  save(indicator: StoredIndicator): void {
    const all = this.getAll();
    const existingIndex = all.findIndex(i => i.id === indicator.id);
    
    if (existingIndex >= 0) {
      all[existingIndex] = { ...indicator, updatedAt: new Date().toISOString() };
    } else {
      all.push({
        ...indicator,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: STORAGE_VERSION,
      indicators: all,
    }));
  },

  delete(id: string): void {
    const all = this.getAll().filter(i => i.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: STORAGE_VERSION,
      indicators: all,
    }));
  },
};
```

##### Runtime Loading

Stored indicators are loaded at runtime and converted to executable `UserIndicatorDefinition` objects:

```ts
// src/utils/indicatorLoader.ts

export function loadStoredIndicators(): UserIndicatorDefinition[] {
  const stored = indicatorStorage.getAll();
  const loaded: UserIndicatorDefinition[] = [];
  
  for (const item of stored) {
    try {
      // Parse and evaluate the stored code safely
      const definition = parseIndicatorCode(item.code);
      loaded.push(definition);
    } catch (error) {
      console.warn(`Failed to load stored indicator ${item.id}:`, error);
    }
  }
  
  return loaded;
}

function parseIndicatorCode(code: string): UserIndicatorDefinition {
  // Use a sandboxed function constructor with no external access
  // This is safe because the code was generated by AI following the contract
  const fn = new Function('Kline', 'UserIndicatorDefinition', `
    ${code}
    return exports.default || exports[Object.keys(exports)[0]];
  `);
  
  return fn();
}
```

**Security Note**: The `new Function` approach is acceptable here because:
1. Code is generated by AI following strict contract rules
2. Code is stored in user's own local storage (user-controlled)
3. Code is validated before execution
4. No network or DOM access is possible within the function scope

##### Dialog Integration with Storage

```ts
// Extended dialog response
export interface IndicatorDialogResponse {
  success: boolean;
  indicator?: UserIndicatorDefinition;
  code?: string;
  explanation?: string;
  errors?: readonly string[];
  suggestions?: readonly string[];
  savedToStorage?: boolean;        // Whether saved to local storage
  storageId?: string;              // ID if saved
}
```

##### User Actions in Dialog UI

| Action | Description |
|--------|-------------|
| **Save** | Save generated indicator to local storage |
| **Load** | Load previously saved indicators from storage |
| **Edit** | Modify a saved indicator and re-save |
| **Delete** | Remove indicator from storage |
| **Export** | Export all saved indicators as JSON file |
| **Import** | Import indicators from JSON file |
| **Share** | Copy indicator code to clipboard |

##### Storage Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    Storage-Enabled Dialog Flow                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Input → AI Generation → Preview & Edit                    │
│                                  ↓                               │
│                         ┌───────────────┐                        │
│                         │  [Save] [Try] │                        │
│                         └───────────────┘                        │
│                               ↓                                  │
│                    Save to LocalStorage                          │
│                               ↓                                  │
│                    Add to Runtime Registry                       │
│                               ↓                                  │
│                    Available in Chart                            │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  On App Start:                                                   │
│  LocalStorage → Load All → Parse → Add to Registry → Chart      │
└─────────────────────────────────────────────────────────────────┘
```

##### Storage Limits & Best Practices

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max indicators | 50 | Prevent storage bloat |
| Max code size | 10 KB per indicator | Typical indicator is 1-3 KB |
| Total storage | ~500 KB | Well within 5-10 MB browser limit |
| Name length | 50 chars | UI display constraints |
| ID format | kebab-case | URL and filesystem safe |

##### Migration Strategy

```ts
interface StorageData {
  version: number;
  indicators: StoredIndicator[];
}

function migrateStorage(data: any): StorageData {
  const version = data.version || 0;
  
  // Future migrations:
  // if (version < 2) { ... migrate to v2 ... }
  
  return {
    version: STORAGE_VERSION,
    indicators: data.indicators || [],
  };
}
```

### 9.4 Edge Cases

| Edge Case | Required Behavior |
| --- | --- |
| Empty `klines` array | Return empty series data and render nothing. |
| Period longer than data length | Use `null` values until the period is available. |
| Zero or negative close value | Avoid division by zero and return `null` for affected points. |
| Unknown returned date | Drop that point during normalization. |
| Duplicate returned date | Keep the last point for that date within the same series. |
| Invalid numeric value | Drop the point and record an adapter error. |
| Indicator throws | Catch the error, skip the indicator, and keep chart rendering. |
| Very long output name | UI shall truncate or constrain text so controls do not resize unpredictably. |

## 10. Validation Criteria

An implementation conforms to this specification when:

- `src/types/indicator.ts` defines the fixed input, definition, result, series, signal, and field interfaces.
- At least one user-defined indicator exists under `src/indicators/user/`.
- `src/indicators/user/index.ts` exports a registry array.
- `ChanlunChart.tsx` renders registered user-defined indicators generically.
- Built-in indicators still work as before.
- User-defined indicator hover fields appear when enabled and available.
- Invalid user-defined output is normalized or skipped without chart crashes.
- `npm run lint` passes.

## 11. Related Specifications / Further Reading

- Existing chart component: `src/components/ChanlunChart.tsx`
- Existing K-line and stock types: `src/types/stock.ts`
- Existing built-in indicator math: `src/utils/indicators.ts`
- Existing project documentation: `README.md`
