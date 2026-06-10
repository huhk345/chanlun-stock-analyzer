---
title: User-Defined Backtest Strategy Interface
version: 1.0
date_created: 2026-06-09
last_updated: 2026-06-09
owner: Project maintainers
tags: [design, backtest, strategy, trading-signals, ai-assisted-development]
---

# Introduction

This specification defines a stable TypeScript interface for user-defined backtest strategies in the ChanLun Stock Analyzer project. The goal is to let a user or AI assistant implement one pure strategy function with fixed input parameters and a fixed return shape. The backtest runner can then execute that function over historical K-line data and convert returned buy or sell decisions into simulated trades.

## 1. Purpose & Scope

This specification applies to the React and TypeScript frontend of the ChanLun Stock Analyzer project.

The scope includes:

- A fixed, AI-friendly user-defined strategy function contract.
- Strategy metadata and parameter definitions.
- The data contract for buy, sell, and hold decisions.
- Backtest runner execution rules for applying strategy decisions.
- **Pre-calculation of indicators as cache before backtest execution.**
- **Incremental ChanLun analysis with caching for fixed segments, strokes, and hubs.**
- **Strict no-future-function guarantees to prevent lookahead bias.**
- Validation, error handling, acceptance criteria, and test strategy.

The scope excludes:

- Live trading, broker integration, real order routing, and investment advice.
- Runtime execution of arbitrary code typed into a browser text area.
- Server-side strategy execution.
- Portfolio optimization across multiple symbols.
- Margin, short selling, options, futures, and leveraged instruments.

Assumptions:

- Market data uses the existing `Kline` interface from `src/types/stock.ts`.
- The initial implementation supports daily K-line data only.
- A user-defined strategy is a source-controlled TypeScript module added to the project, usually under `src/strategies/user/`.
- AI-assisted implementation means an AI assistant receives this fixed interface plus the user's strategy rules and returns a TypeScript module that satisfies this specification.
- ChanLun analysis (merged K-lines, fractions, strokes, segments, hubs) can be incrementally computed with caching for elements that are "fixed" before the current K-line.

## 2. Definitions

| Term | Definition |
| --- | --- |
| K-line | A market candle with date, open, high, low, close, volume, and amount fields. |
| Strategy | A deterministic function that receives market history, current portfolio state, and parameters, then returns a buy, sell, or hold decision. |
| User-defined strategy | A source-controlled TypeScript strategy module implemented by a user or AI assistant using this specification. |
| Backtest runner | The deterministic simulation engine that iterates through K-line data and applies strategy decisions to a virtual portfolio. |
| Decision | The strategy function output for one K-line. It instructs the runner to buy, sell, or hold. |
| Amount | The requested order size. The amount must include a numeric value and an explicit unit. |
| Cash amount | An amount measured in account currency. For example, buy `1000` CNY of shares. |
| Share amount | An amount measured in shares. For example, sell `200` shares. |
| Percent amount | A percentage of available cash for buys or a percentage of current position shares for sells. |
| Position | The currently held shares for the backtested symbol plus cost basis values maintained by the runner. |
| Fill | The simulated execution of a buy or sell decision at a price chosen by the runner. |

## 3. Requirements, Constraints & Guidelines

- **REQ-001**: The project shall expose a user-defined backtest strategy contract from `src/types/strategy.ts`.
- **REQ-002**: Every user-defined strategy shall implement exactly one fixed decision signature: `decide(input: UserStrategyInput): UserStrategyDecision`.
- **REQ-003**: The strategy decision function shall be synchronous, deterministic, and side-effect free.
- **REQ-004**: The strategy decision function shall receive all market data, account state, position state, and parameter values through the `UserStrategyInput` object only.
- **REQ-005**: The strategy decision function shall return one of three actions: `BUY`, `SELL`, or `HOLD`.
- **REQ-006**: A `BUY` or `SELL` decision shall include an explicit numeric `amount.value` and `amount.unit`.
- **REQ-007**: A `HOLD` decision shall not require an amount. If an amount is provided for `HOLD`, the runner shall ignore it.
- **REQ-008**: User-defined strategy modules shall export a `UserStrategyDefinition`.
- **REQ-009**: User-defined strategies shall be registered in a single registry file so the backtest UI can discover them without importing individual strategy modules.
- **REQ-010**: The backtest UI shall allow the user to select one registered strategy before running a backtest.
- **REQ-011**: The backtest UI shall allow the user to select indicators from a list of available indicators for the chosen strategy.
- **REQ-012**: The backtest UI shall display indicator selection controls with checkboxes or multi-select for each available indicator.
- **REQ-013**: Selected indicators shall be pre-calculated and passed to the strategy through the `indicators` cache.
- **REQ-014**: Strategy parameter values shall come from metadata-defined defaults until future UI support allows users to edit them.
- **REQ-015**: The backtest runner shall call the strategy once per eligible K-line, from oldest to newest.
- **REQ-016**: The runner shall pass only historical data up to and including the current K-line to the strategy.
- **REQ-017**: The runner shall not allow a strategy to inspect future K-lines through its input.
- **REQ-018**: The runner shall convert accepted strategy decisions into `BacktestTrade` records.
- **REQ-019**: The runner shall reject invalid decisions without crashing the backtest.
- **REQ-020**: The runner shall isolate strategy errors and return a backtest result with diagnostics instead of breaking the React UI.
- **REQ-021**: The strategy function shall be usable by AI assistants without requiring edits to the backtest runner, chart component, or Supabase utilities.
- **REQ-022**: Strategy IDs shall be stable, unique, lowercase kebab-case strings.
- **REQ-023**: The implementation shall preserve existing `BacktestResult` fields and may add optional fields only when needed for diagnostics.
- **REQ-024**: The backtest UI shall provide an AI-assisted strategy creation dialog where users describe trading ideas in natural language and AI generates a runnable strategy module.
- **REQ-025**: The strategy creation dialog shall reuse the same AI model selection logic as the existing `IndicatorDialog`.
- **REQ-026**: Generated strategies shall be saved to local storage and persist across browser sessions.
- **REQ-027**: Stored strategies shall appear in the strategy selection dropdown alongside source-controlled strategies.
- **REQ-028**: The strategy creation dialog shall validate generated code against the `UserStrategyDefinition` contract before allowing save.
- **REQ-029**: The backtest UI shall support a day-by-day stepping mode where the user can advance through the backtest one K-line at a time.
- **REQ-030**: The day-by-day stepper shall support forward, backward, and jump-to navigation.
- **REQ-031**: The day-by-day stepper shall display the strategy decision, account state, position state, and any executed trade at each step.
- **REQ-032**: The indicator selection UI shall include indicators created through the `IndicatorDialog` (stored in local storage) alongside source-controlled indicators.

- **CON-001**: User-defined strategies shall run in the browser bundle as normal TypeScript modules. The project shall not use `eval`, `new Function`, remote code execution, or dynamic code strings for this feature.
- **CON-002**: The runner shall simulate long-only trading. It shall not allow negative cash, negative shares, margin, or short positions.
- **CON-003**: The initial implementation shall execute fills at the current K-line close price.
- **CON-004**: The runner shall clamp order size to available cash for buys and held shares for sells.
- **CON-005**: The runner shall reject `NaN`, `Infinity`, `-Infinity`, zero, and negative order amounts.
- **CON-006**: The runner shall use the same date string format as `Kline.date` for all generated trades.
- **CON-007**: New code shall preserve TypeScript type safety and pass `npm run lint`.
- **CON-008**: Source-controlled strategies (in `src/strategies/user/`) shall run as normal TypeScript modules without `eval` or `new Function`. Locally stored strategies may use `new Function` for runtime evaluation since the code is user-controlled and generated by AI following the contract.

- **GUD-001**: Put reusable strategy math helpers in `src/utils/` only when they are shared by more than one strategy.
- **GUD-002**: Put user-defined strategy modules under `src/strategies/user/`.
- **GUD-003**: Keep user-defined strategy logic pure. Given the same input, it should return the same output.
- **GUD-004**: Prefer one user-defined strategy per file.
- **GUD-005**: Keep display metadata close to the strategy definition so the backtest UI can render it without special cases.
- **GUD-006**: Include a concise `reason` in buy or sell decisions so the trade ledger can show why the strategy acted.

## 4. Interfaces & Data Contracts

### 4.1 Source File Layout

The implementation should introduce these files:

```text
src/types/strategy.ts
src/strategies/user/index.ts
src/strategies/user/example-moving-average-cross.ts
src/utils/backtestRunner.ts
src/utils/backtestStepper.ts
src/utils/strategyAdapter.ts
src/utils/strategyStorage.ts
src/utils/strategyLoader.ts
src/components/BacktestManager.tsx
src/components/StrategyDialog.tsx
```

Responsibilities:

| File | Responsibility |
| --- | --- |
| `src/types/strategy.ts` | Owns the fixed user-defined strategy interfaces. |
| `src/strategies/user/index.ts` | Exports the registry of user-defined strategies. |
| `src/strategies/user/*.ts` | Contains individual user-defined strategy definitions. |
| `src/utils/strategyAdapter.ts` | Validates strategy definitions and normalizes decisions. |
| `src/utils/backtestRunner.ts` | Iterates over K-lines, calls the selected strategy, simulates fills, and returns a `BacktestResult`. |
| `src/utils/backtestStepper.ts` | Provides day-by-day stepping through a backtest with forward, backward, and jump navigation. |
| `src/utils/strategyStorage.ts` | Manages local storage persistence for user strategies. |
| `src/utils/strategyLoader.ts` | Loads and parses stored strategies at runtime. |
| `src/components/BacktestManager.tsx` | Lets users select a strategy, run a backtest, step day-by-day, display trades, and save results. |
| `src/components/StrategyDialog.tsx` | Dialog UI for AI-assisted strategy creation and storage management. |

### 4.2 Fixed Function Signature

Every user-defined strategy shall implement this exact decision shape:

```ts
import type { Kline } from './stock';

export type StrategyTimeframe = 'daily';

export type StrategyParamValue = string | number | boolean;

export interface UserStrategyInput {
  symbol: string;
  timeframe: StrategyTimeframe;
  klines: readonly Kline[];
  currentIndex: number;
  currentKline: Kline;
  account: Readonly<BacktestAccountState>;
  position: Readonly<BacktestPositionState>;
  trades: readonly BacktestTradeSnapshot[];
  params: Readonly<Record<string, StrategyParamValue>>;
  indicators?: Readonly<IndicatorCache>;
  chanlun?: Readonly<ChanLunCache>;
  /** Currency for the backtest (e.g., 'CNY', 'USD') */
  currency: string;
  /** Initial money/cash for the backtest */
  initialCash: number;
}

export type UserStrategyFunction = (
  input: UserStrategyInput
) => UserStrategyDecision;
```

Input rules:

- `klines` shall contain only data from the first backtest K-line through `currentKline`.
- `klines` shall be sorted from oldest to newest.
- `currentIndex` shall be the zero-based index of `currentKline` inside the current `klines` array.
- `currentKline` shall equal `klines[currentIndex]`.
- `account`, `position`, and `trades` shall represent state before applying the current decision.
- `params` shall include resolved parameter values after applying defaults.
- `indicators` shall contain pre-calculated indicator values for all K-lines up to and including `currentIndex`.
- `chanlun` shall contain ChanLun analysis (strokes, segments, hubs) for K-lines up to and including `currentIndex`.
- `currency` shall specify the account currency (e.g., 'CNY', 'USD') for the backtest.
- `initialCash` shall specify the initial money/cash amount for the backtest.
- The strategy shall treat all input objects and arrays as immutable.

### 4.3 Account, Position, and Trade Snapshot Contracts

```ts
export interface BacktestAccountState {
  initialCash: number;
  cash: number;
  equity: number;
  /** Currency for the account (e.g., 'CNY', 'USD') */
  currency: string;
}

export interface BacktestPositionState {
  shares: number;
  averageCost: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
}

export interface BacktestTradeSnapshot {
  id: string;
  date: string;
  action: 'BUY' | 'SELL';
  price: number;
  shares: number;
  value: number;
  reason?: string;
}
```

State rules:

- `account.cash` shall be the available cash before the current decision.
- `account.equity` shall equal `account.cash + position.marketValue` before the current decision.
- `position.shares` shall be `0` when there is no open position.
- `position.averageCost` shall be `0` when there is no open position.
- `trades` shall include only trades already executed before the current decision.

### 4.4 Strategy Definition Contract

```ts
export interface UserStrategyDefinition {
  id: string;
  name: string;
  description?: string;
  defaultSelected?: boolean;
  params?: readonly UserStrategyParamDefinition[];
  availableIndicators?: readonly AvailableIndicator[];
  requiredIndicators?: readonly RequiredIndicator[];
  requiresChanLun?: boolean;
  decide: UserStrategyFunction;
}

export interface AvailableIndicator {
  id: string;
  name: string;
  description?: string;
  defaultSelected?: boolean;
  params?: readonly UserStrategyParamDefinition[];
}

export interface UserStrategyParamDefinition {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean';
  defaultValue: StrategyParamValue;
  min?: number;
  max?: number;
  step?: number;
}

export interface RequiredIndicator {
  id: string;
  params?: Readonly<Record<string, StrategyParamValue>>;
}
```

Definition rules:

- `id` shall be unique across all registered strategies.
- `id` shall match `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`.
- `name` shall be short enough to fit in strategy selection controls.
- `params` shall define every parameter used by `decide`.
- `decide` shall not read missing parameters without applying a local fallback.
- `availableIndicators` shall list indicators the user can select from in the backtest UI.
- `availableIndicators[].id` shall reference an indicator ID from the indicator registry.
- `availableIndicators[].defaultSelected` shall determine if the indicator is pre-selected in the UI.
- `requiredIndicators` shall list indicators that are always calculated regardless of user selection.
- `requiredIndicators` shall be merged with user-selected indicators from `availableIndicators` during backtest execution.
- `requiresChanLun` shall be `true` if the strategy uses ChanLun analysis (strokes, segments, hubs).

### 4.5 Decision Contract

The strategy decision returns the action to take and the amount of shares to trade:

```ts
export type UserStrategyAction = 'BUY' | 'SELL' | 'HOLD';

export type UserStrategyAmountUnit =
  | 'cash'
  | 'shares'
  | 'percent';

export interface UserStrategyDecision {
  /** The trading action: BUY, SELL, or HOLD */
  action: UserStrategyAction;
  /** The amount to trade (required for BUY and SELL) */
  amount?: UserStrategyAmount;
  /** Optional reason explaining the decision */
  reason?: string;
  /** Optional confidence level from 0 to 1 */
  confidence?: number;
}

export interface UserStrategyAmount {
  /** Unit of the amount: 'cash' (currency), 'shares', or 'percent' */
  unit: UserStrategyAmountUnit;
  /** Numeric value of the amount */
  value: number;
}
```

Decision rules:

- `action: 'BUY'` means the runner should attempt to open or add to a long position.
- `action: 'SELL'` means the runner should attempt to reduce or close the current long position.
- `action: 'HOLD'` means the runner should take no trading action on the current K-line.
- `amount.unit: 'cash'` means `amount.value` is account currency. It is valid for `BUY` only.
- `amount.unit: 'shares'` means `amount.value` is a number of shares. It is valid for `BUY` and `SELL`.
- `amount.unit: 'percent'` means `amount.value` is a percentage from `0` through `100`.
- For `BUY` plus `percent`, the percentage applies to available cash.
- For `SELL` plus `percent`, the percentage applies to currently held shares.
- `confidence` is optional and shall be a number from `0` through `1` when provided.
- `reason` is optional and should be short enough to display in the trade ledger.

### 4.6 Indicator Cache Contract

The indicator cache provides pre-calculated indicator values to the strategy:

```ts
export interface IndicatorCache {
  byId: Readonly<Record<string, IndicatorData>>;
}

export interface IndicatorData {
  id: string;
  name: string;
  series: readonly IndicatorSeries[];
}

export interface IndicatorSeries {
  id: string;
  name: string;
  type: 'line' | 'histogram';
  data: readonly IndicatorPoint[];
}

export interface IndicatorPoint {
  time: string;
  value: number | null;
}
```

Indicator cache rules:

- `byId` shall be keyed by indicator ID.
- Each `IndicatorData` shall contain the calculated output for one indicator.
- `series[].data` shall contain values for all K-lines up to and including the current K-line when passed to the strategy.
- `series[].data[].time` shall match K-line dates.
- `series[].data[].value` may be `null` for gaps or undefined values.
- The runner shall pre-calculate all indicators in `requiredIndicators` plus user-selected indicators from `availableIndicators` before backtest iteration.
- The runner shall pass the indicator cache through `UserStrategyInput.indicators`.

### 4.7 Registry Contract

The registry shall export an array:

```ts
import type { UserStrategyDefinition } from '../../types/strategy';
import { exampleMovingAverageCrossStrategy } from './example-moving-average-cross';

export const userStrategies: readonly UserStrategyDefinition[] = [
  exampleMovingAverageCrossStrategy,
];
```

Registry rules:

- The registry shall validate duplicate IDs during development.
- The registry shall export only strategy definitions, not React components or runner internals.
- The first strategy with `defaultSelected: true` shall be selected by default in the backtest UI.
- If no strategy has `defaultSelected: true`, the first registered strategy shall be selected by default.

### 4.8 Backtest Runner Contract

The runner should expose a function with this shape:

```ts
import type { BacktestResult } from '../types/stock';
import type { UserStrategyDefinition } from '../types/strategy';

export interface RunBacktestInput {
  klines: readonly Kline[];
  symbol: string;
  userId: string;
  initialCash: number;
  /** Currency for the backtest (e.g., 'CNY', 'USD') */
  currency: string;
  stopLossPercent?: number;
  strategy: UserStrategyDefinition;
  params?: Readonly<Record<string, unknown>>;
}

export interface RunBacktestOutput {
  result: BacktestResult;
  diagnostics: readonly BacktestDiagnostic[];
}

export interface BacktestDiagnostic {
  date?: string;
  level: 'warning' | 'error';
  message: string;
}

export function runBacktest(input: RunBacktestInput): RunBacktestOutput;
```

Runner rules:

- The runner shall return a `BacktestResult` even when no trades occur.
- The runner shall calculate `finalBalance` from final cash plus final market value.
- The runner shall calculate `totalReturnPercent` from `initialCash` and `finalBalance`.
- The runner shall calculate `totalTrades` from executed trades only.
- The runner shall calculate `winningTrades` and `winRate` from completed sell trades with realized profit and loss.
- The runner shall use the selected strategy `id` or `name` as the `signalType` for generated `BacktestTrade` records.
- The runner shall use `reason` when available to enrich diagnostics or future trade display fields.

### 4.9 Indicator Selection UI Contract

The backtest UI shall provide indicator selection controls:

```ts
export interface IndicatorSelectionState {
  strategyId: string;
  selectedIndicatorIds: readonly string[];
  indicatorParams: Readonly<Record<string, Record<string, StrategyParamValue>>>;
}
```

UI rules:

- When a strategy is selected, the UI shall display all indicators from `strategy.availableIndicators`.
- Each indicator shall show as a checkbox with the indicator `name` and optional `description`.
- Indicators with `defaultSelected: true` shall be pre-checked.
- The user may check or uncheck any indicator in `availableIndicators`.
- Indicators in `requiredIndicators` shall not appear in the selection UI since they are always calculated.
- If an indicator has `params`, the UI may display parameter inputs for each param definition.
- The selected indicator IDs shall be passed to the backtest runner as part of the run configuration.
- The UI shall preserve indicator selection state when switching between strategies if possible.
- The UI shall reset to `defaultSelected` values when the user explicitly requests a reset.
- The indicator selection UI shall also include indicators created through the `IndicatorDialog` (stored in local storage) alongside source-controlled indicators from the registry.

### 4.10 AI-Assisted Strategy Creation Contract

The backtest UI shall provide an AI-assisted strategy creation dialog, similar to the existing `IndicatorDialog`, where users describe trading ideas in natural language and AI generates a runnable strategy module.

```ts
export interface StrategyDialogRequest {
  /** User's natural language description of the trading strategy idea */
  userDescription: string;
  /** Optional context for generation */
  context?: {
    symbol?: string;
    existingStrategyIds?: readonly string[];
    availableIndicatorIds?: readonly string[];
  };
}

export interface StrategyDialogResponse {
  /** Whether generation succeeded */
  success: boolean;
  /** Generated strategy definition (if successful) */
  strategy?: UserStrategyDefinition;
  /** Generated TypeScript code (if successful) */
  code?: string;
  /** Explanation of the generated strategy */
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

export interface StoredStrategy {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Optional description */
  description?: string;
  /** Full TypeScript source code */
  code: string;
  /** Creation timestamp (ISO string) */
  createdAt: string;
  /** Last update timestamp (ISO string) */
  updatedAt: string;
  /** Whether this strategy is selected by default */
  defaultSelected?: boolean;
  /** Parameter definitions */
  params?: readonly UserStrategyParamDefinition[];
  /** Available indicators this strategy can use */
  availableIndicators?: readonly AvailableIndicator[];
  /** Required indicators this strategy always needs */
  requiredIndicators?: readonly RequiredIndicator[];
  /** Whether this strategy requires ChanLun analysis */
  requiresChanLun?: boolean;
}

export interface StrategyStorageData {
  /** Storage format version */
  version: number;
  /** Stored strategies */
  strategies: StoredStrategy[];
}
```

Dialog UI rules:

- The backtest UI shall include a "Create Strategy" button that opens the strategy creation dialog.
- The dialog shall provide a text area for the user to describe their trading idea in natural language.
- The dialog shall provide an AI model selector, reusing the same model selection logic as `IndicatorDialog`.
- When the user submits their idea, the dialog shall call the AI to generate a `UserStrategyDefinition` module.
- The AI prompt shall include the fixed `UserStrategyDefinition` interface, the `UserStrategyInput` contract, and the `UserStrategyDecision` contract from this specification.
- The AI prompt shall also include the list of available indicators (from both the registry and local storage) so the generated strategy can reference them.
- The generated code shall be shown in a preview area with syntax highlighting before saving.
- The user may edit the generated code before saving.
- The dialog shall validate the generated code against the `UserStrategyDefinition` contract before allowing save.
- The dialog shall save the strategy to local storage using `StrategyStorageData`.
- Saved strategies shall persist across browser sessions and be automatically loaded on app startup.
- The dialog shall provide a "Manage" tab to view, edit, delete, export, and import stored strategies.
- Stored strategies shall appear in the strategy selection dropdown alongside source-controlled strategies.
- When a stored strategy is selected, its `availableIndicators` shall be shown in the indicator selection UI.
- The dialog shall support streaming code generation with real-time preview.

AI prompt template for strategy generation:

```text
Implement a user-defined backtest strategy for this TypeScript project.

Use exactly the UserStrategyDefinition interface from src/types/strategy.ts.
Do not edit the backtest runner, chart, React components, or storage code.
Create one strategy module that exports a UserStrategyDefinition.

Available indicators the strategy can use:
[List available indicator IDs and names here]

Strategy rules:
[User's natural language description here]

The decide function receives UserStrategyInput with:
- klines: historical K-line data up to current index
- currentIndex: zero-based index of current K-line
- currentKline: the current K-line being evaluated
- account: current account state (cash, equity, currency)
- position: current position state (shares, averageCost, marketValue)
- trades: list of previously executed trades
- params: resolved parameter values
- indicators: pre-calculated indicator cache (if any selected)
- chanlun: ChanLun analysis cache (if requiresChanLun is true)
- currency: the account currency (e.g., 'CNY', 'USD')
- initialCash: the initial money/cash amount for the backtest

Return UserStrategyDecision with:
- action: 'BUY', 'SELL', or 'HOLD' (the trading action to take)
- amount: { unit: 'cash' | 'shares' | 'percent', value: number } (required for BUY/SELL, specifies how much to trade)
- reason: optional string explaining the decision
- confidence: optional number 0-1

Use percent amounts unless the strategy specifically needs cash or shares.
Keep the decide function pure and deterministic.
```

### 4.11 Day-by-Day Backtest Stepping Contract

The backtest UI shall support a day-by-day stepping mode where the user can advance through the backtest one K-line at a time, observing the strategy decision, account state, and position state at each step.

```ts
export interface BacktestStepState {
  /** Current step index (0-based, maps to klines array index) */
  currentStepIndex: number;
  /** Total number of K-lines in the backtest range */
  totalSteps: number;
  /** The K-line being evaluated at the current step */
  currentKline: Kline;
  /** The strategy decision at the current step */
  decision: UserStrategyDecision | null;
  /** Account state before applying the current step's decision */
  accountBefore: BacktestAccountState;
  /** Account state after applying the current step's decision */
  accountAfter: BacktestAccountState;
  /** Position state before applying the current step's decision */
  positionBefore: BacktestPositionState;
  /** Position state after applying the current step's decision */
  positionAfter: BacktestPositionState;
  /** Trade executed at this step (if any) */
  tradeExecuted: BacktestTradeSnapshot | null;
  /** Indicator values at the current step */
  indicatorSnapshot: Readonly<IndicatorCache> | null;
  /** ChanLun analysis at the current step */
  chanlunSnapshot: Readonly<ChanLunCache> | null;
  /** Diagnostic messages for this step */
  diagnostics: readonly BacktestDiagnostic[];
  /** Whether the backtest has completed */
  isFinished: boolean;
}

export interface BacktestStepperInput {
  klines: readonly Kline[];
  symbol: string;
  userId: string;
  initialCash: number;
  /** Currency for the backtest (e.g., 'CNY', 'USD') */
  currency: string;
  stopLossPercent?: number;
  strategy: UserStrategyDefinition;
  params?: Readonly<Record<string, unknown>>;
  selectedIndicatorIds?: readonly string[];
}

export type BacktestStepper = {
  /** Initialize the stepper and return the initial state (before any step) */
  start(): BacktestStepState;
  /** Advance one step and return the new state */
  stepForward(): BacktestStepState;
  /** Go back one step and return the previous state */
  stepBackward(): BacktestStepState;
  /** Jump to a specific step index */
  jumpTo(index: number): BacktestStepState;
  /** Run all remaining steps and return the final result */
  runAll(): RunBacktestOutput;
  /** Get the current step state without advancing */
  getCurrentState(): BacktestStepState;
  /** Whether the stepper has been initialized */
  isStarted: boolean;
};
```

Stepper rules:

- The stepper shall maintain an internal history of all step states to support backward navigation.
- `stepForward` shall call the strategy's `decide` function for the next K-line, simulate the fill, and return the updated state.
- `stepBackward` shall restore the previous step state from history without re-executing the strategy.
- `jumpTo` shall replay from the beginning up to the target index if the target is not in history, or restore from history if available.
- `runAll` shall execute all remaining steps from the current position and return a standard `RunBacktestOutput`.
- The stepper shall pre-calculate all selected indicators before the first step, so `indicatorSnapshot` is available at every step.
- The stepper shall pre-calculate ChanLun analysis if the strategy requires it.
- The UI shall display the current K-line highlighted on the chart when stepping.
- The UI shall display the strategy decision, account state, position state, and any executed trade for the current step.
- The UI shall provide controls: Step Forward, Step Backward, Jump To (date or index), Run All, and Reset.
- The UI shall show a progress bar indicating the current step position within the total K-line range.
- The UI shall allow the user to click on a specific date in the trade ledger or chart to jump to that step.

## 5. Acceptance Criteria

- **AC-001**: Given a registered strategy with `decide(input): UserStrategyDecision`, When the user runs a backtest, Then the runner shall call the strategy once per eligible K-line in chronological order.
- **AC-002**: Given a strategy returns `{ action: 'BUY', amount: { unit: 'percent', value: 50 } }`, When the account has available cash, Then the runner shall buy using 50 percent of available cash at the current close price.
- **AC-003**: Given a strategy returns `{ action: 'SELL', amount: { unit: 'percent', value: 100 } }`, When the account has an open position, Then the runner shall sell all held shares at the current close price.
- **AC-004**: Given a strategy returns `{ action: 'HOLD' }`, When the runner processes the decision, Then no trade shall be added for that K-line.
- **AC-005**: Given a strategy returns a buy amount larger than available cash, When the runner processes the decision, Then the runner shall clamp the buy to available cash.
- **AC-006**: Given a strategy returns a sell amount larger than held shares, When the runner processes the decision, Then the runner shall clamp the sell to held shares.
- **AC-007**: Given a strategy returns an invalid amount, When the runner processes the decision, Then the runner shall skip that decision and add a warning diagnostic.
- **AC-008**: Given a strategy throws an error, When the runner processes that K-line, Then the runner shall stop calling that strategy, return the trades already generated, and include an error diagnostic.
- **AC-009**: Given an AI assistant implements a strategy module using this spec, When the module is registered, Then no changes shall be required in `BacktestManager.tsx` other than normal strategy selection and execution support.
- **AC-010**: Given no strategy generates buy or sell decisions, When the backtest completes, Then the result shall show zero trades, unchanged cash, and zero total return.
- **AC-011**: Given a strategy defines `availableIndicators`, When the backtest UI renders, Then the UI shall display a list of selectable indicators with checkboxes.
- **AC-012**: Given a strategy defines `availableIndicators` with `defaultSelected: true`, When the backtest UI renders, Then those indicators shall be pre-checked.
- **AC-013**: Given the user selects indicators from `availableIndicators`, When the backtest runs, Then the runner shall pre-calculate only the selected indicators plus `requiredIndicators`.
- **AC-014**: Given the runner pre-calculates indicators, When the strategy `decide` function is called, Then `input.indicators.byId` shall contain data for all calculated indicators.
- **AC-015**: Given a strategy accesses `input.indicators.byId['ma-20']`, When the indicator was calculated, Then the strategy shall receive the indicator's series data for all K-lines up to the current index.
- **AC-016**: Given a strategy defines both `availableIndicators` and `requiredIndicators`, When the backtest runs, Then both sets of indicators shall be calculated and available in the cache.
- **AC-017**: Given the user opens the strategy creation dialog, When the user describes a trading idea in natural language and submits, Then the AI shall generate a `UserStrategyDefinition` module that satisfies this specification.
- **AC-018**: Given the AI generates a strategy, When the code is validated, Then the dialog shall verify the code exports a valid `UserStrategyDefinition` with a `decide` function, unique `id`, and `name`.
- **AC-019**: Given the user saves a generated strategy, When the app restarts, Then the stored strategy shall be automatically loaded and appear in the strategy selection dropdown.
- **AC-020**: Given the user selects a stored strategy, When the backtest UI renders, Then the strategy's `availableIndicators` shall appear in the indicator selection UI.
- **AC-021**: Given the user edits a stored strategy's code, When the user saves the edit, Then the updated strategy shall replace the previous version in local storage.
- **AC-022**: Given the user deletes a stored strategy, When the delete completes, Then the strategy shall be removed from local storage and the strategy selection dropdown.
- **AC-023**: Given the user exports strategies, When the export completes, Then a JSON file containing all stored strategies shall be downloaded.
- **AC-024**: Given the user imports a valid strategy JSON file, When the import completes, Then the strategies shall be added to local storage and available in the selection dropdown.
- **AC-025**: Given the user starts a day-by-day backtest, When the stepper is initialized, Then the UI shall display the first K-line with the strategy decision and account state.
- **AC-026**: Given the user clicks Step Forward, When the next K-line is processed, Then the UI shall display the strategy decision, account state before and after, and any executed trade for that step.
- **AC-027**: Given the user clicks Step Backward, When a previous step exists in history, Then the UI shall restore and display the previous step state without re-executing the strategy.
- **AC-028**: Given the user clicks Jump To a specific date, When that date exists in the K-line range, Then the stepper shall advance or rewind to that step and display its state.
- **AC-029**: Given the user clicks Run All during stepping, When all remaining steps complete, Then the stepper shall return a standard `RunBacktestOutput` with the full result.
- **AC-030**: Given the day-by-day stepper is active, When the current step has indicator data, Then the UI shall display the indicator values for the current K-line.
- **AC-031**: Given the day-by-day stepper is active, When the current step produces a trade, Then the UI shall highlight the trade on the chart and in the trade ledger.
- **AC-032**: Given the AI prompt includes available indicator IDs, When the AI generates a strategy, Then the generated strategy may reference those indicators in its `availableIndicators` or `requiredIndicators`.
- **AC-033**: Given a stored strategy has invalid code, When the app loads, Then the strategy shall be skipped with a console warning and shall not crash the app.

## 6. Test Automation Strategy

- **Test Levels**: Unit tests for the strategy adapter and backtest runner; integration tests for `BacktestManager.tsx` strategy selection and run flow.
- **Frameworks**: Use the existing TypeScript compiler check through `npm run lint`. Add a test runner only if the project adopts one for broader automated testing.
- **Test Data Management**: Use small in-memory K-line arrays with deterministic prices and dates.
- **Coverage Requirements**: Cover buy, sell, hold, invalid amount, clamped order, thrown strategy error, empty K-line input, and no-trade scenarios.
- **Performance Testing**: Verify that a strategy running over at least 5,000 K-lines completes without blocking the UI for an unacceptable duration. If needed, future work may move backtests to a Web Worker.
- **CI/CD Integration**: The project should run `npm run lint` in CI after adding strategy and backtest runner code.

## 7. Rationale & Context

The current `BacktestManager.tsx` can display a backtest result and trade ledger, but its run flow does not yet call a user-defined trading strategy. A stable strategy interface lets users describe trading logic in plain language and ask an AI assistant to implement only the strategy module. This reduces accidental edits to chart rendering, storage, and UI code.

The function receives an input object rather than positional arguments because it is easier to extend safely and easier for AI assistants to implement correctly. The return value uses an explicit `amount.unit` because a numeric amount alone is ambiguous. A value of `50` could mean 50 shares, 50 currency units, or 50 percent. The explicit unit makes backtest behavior testable and repeatable.

The strategy receives only historical K-lines through the current K-line to prevent lookahead bias. The backtest runner, not the strategy, owns fill price, cash constraints, position accounting, profit and loss, and trade record creation.

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**: TickFlow API or local merged stock data - Provides historical K-line data already used by the application.

### Third-Party Services

- **SVC-001**: Supabase - Stores backtest results for authenticated users through existing persistence utilities.

### Infrastructure Dependencies

- **INF-001**: Browser runtime - Executes TypeScript strategy modules bundled by Vite.

### Data Dependencies

- **DAT-001**: K-line data - Requires date, open, high, low, close, volume, and amount fields for each bar.

### Technology Platform Dependencies

- **PLT-001**: React and TypeScript frontend - Strategy definitions and runner contracts shall be type checked by the existing project toolchain.

### Compliance Dependencies

- **COM-001**: Educational-use disclaimer - The feature shall preserve the project's disclaimer that generated analysis and backtests are for research and education only and are not investment advice.

## 9. Examples & Edge Cases

### 9.1 Example Strategy Module

```ts
import type { UserStrategyDefinition } from '../../types/strategy';

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export const exampleMovingAverageCrossStrategy: UserStrategyDefinition = {
  id: 'ma-cross',
  name: 'MA Cross',
  description: 'Buys when the fast moving average crosses above the slow moving average and sells on the reverse cross.',
  defaultSelected: true,
  params: [
    { key: 'fastPeriod', label: 'Fast period', type: 'number', defaultValue: 5, min: 2, max: 60, step: 1 },
    { key: 'slowPeriod', label: 'Slow period', type: 'number', defaultValue: 20, min: 3, max: 120, step: 1 },
    { key: 'buyPercent', label: 'Buy percent', type: 'number', defaultValue: 100, min: 1, max: 100, step: 1 },
  ],
  decide({ klines, position, params }) {
    const fastPeriod = typeof params.fastPeriod === 'number' ? params.fastPeriod : 5;
    const slowPeriod = typeof params.slowPeriod === 'number' ? params.slowPeriod : 20;
    const buyPercent = typeof params.buyPercent === 'number' ? params.buyPercent : 100;

    if (klines.length < slowPeriod + 1) {
      return { action: 'HOLD', reason: 'Not enough data' };
    }

    const closes = klines.map((kline) => kline.close);
    const previousFast = average(closes.slice(-fastPeriod - 1, -1));
    const previousSlow = average(closes.slice(-slowPeriod - 1, -1));
    const currentFast = average(closes.slice(-fastPeriod));
    const currentSlow = average(closes.slice(-slowPeriod));

    if (previousFast === null || previousSlow === null || currentFast === null || currentSlow === null) {
      return { action: 'HOLD' };
    }

    const crossedUp = previousFast <= previousSlow && currentFast > currentSlow;
    const crossedDown = previousFast >= previousSlow && currentFast < currentSlow;

    if (crossedUp && position.shares === 0) {
      return {
        action: 'BUY',
        amount: { unit: 'percent', value: buyPercent },
        reason: 'Fast MA crossed above slow MA',
      };
    }

    if (crossedDown && position.shares > 0) {
      return {
        action: 'SELL',
        amount: { unit: 'percent', value: 100 },
        reason: 'Fast MA crossed below slow MA',
      };
    }

    return { action: 'HOLD' };
  },
};
```

### 9.2 AI-Assisted Implementation Prompt Template

```text
Implement a user-defined backtest strategy for this TypeScript project.

Use exactly the UserStrategyDefinition interface from src/types/strategy.ts.
Do not edit the backtest runner, chart, React components, or storage code.
Create one strategy module under src/strategies/user/.
Export one UserStrategyDefinition.

Strategy rules:
[Describe the user's buy and sell rules here.]

Return BUY, SELL, or HOLD.
Every BUY or SELL must include amount.unit and amount.value.
Use percent amounts unless the strategy specifically needs cash or shares.
Keep the decide function pure and deterministic.
```

### 9.3 Edge Cases

| Edge Case | Expected Behavior |
| --- | --- |
| Empty K-line array | Runner returns a no-trade result with a warning diagnostic. |
| One K-line only | Strategy may be called once, but most strategies should return `HOLD`. |
| Buy with no cash | Runner skips the decision and adds a warning diagnostic. |
| Sell with no shares | Runner skips the decision and adds a warning diagnostic. |
| Percent amount above 100 | Runner clamps to 100 and adds a warning diagnostic. |
| Percent amount below or equal to 0 | Runner skips the decision and adds a warning diagnostic. |
| Cash amount on sell | Runner skips the decision and adds a warning diagnostic. |
| Invalid confidence | Runner ignores confidence and adds a warning diagnostic. |
| Strategy returns unknown action | TypeScript should prevent this; runtime adapter shall treat it as invalid if it occurs. |
| Strategy throws | Runner returns partial result and an error diagnostic. |

## 10. Validation Criteria

- The project contains `src/types/strategy.ts` with the contracts defined in this specification.
- The project contains a user strategy registry under `src/strategies/user/index.ts`.
- At least one example strategy module compiles and can be selected in the backtest UI.
- The backtest runner can execute the example strategy and produce `BacktestResult.trades` from buy and sell decisions.
- Invalid decisions are skipped with diagnostics and do not crash the UI.
- The implementation passes `npm run lint`.
- The strategy interface is documented clearly enough that an AI assistant can implement a new strategy module without touching runner or UI internals.
- The indicator cache pre-calculates indicators before backtest iteration.
- The ChanLun cache incrementally updates with fixed-element caching.
- The no-future-function validator detects and reports future data access.
- Performance metrics accurately reflect cache hit rates and execution times.
- The `StrategyDialog` component allows users to describe a trading idea in natural language and generate a strategy via AI.
- Stored strategies persist in local storage and are loaded automatically on app startup.
- The day-by-day stepper allows forward, backward, and jump-to navigation through backtest steps.
- The stepper displays strategy decision, account state, position state, and executed trade at each step.
- The indicator selection UI includes both registry indicators and locally stored indicators from `IndicatorDialog`.

## 11. Related Specifications / Further Reading

- [User-Defined Indicator Interface and K-Line Chart Rendering](./spec-design-user-defined-indicators.md)
- [Project README](../README.md)
