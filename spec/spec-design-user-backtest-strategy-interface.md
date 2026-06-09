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
- **REQ-011**: Strategy parameter values shall come from metadata-defined defaults until future UI support allows users to edit them.
- **REQ-012**: The backtest runner shall call the strategy once per eligible K-line, from oldest to newest.
- **REQ-013**: The runner shall pass only historical data up to and including the current K-line to the strategy.
- **REQ-014**: The runner shall not allow a strategy to inspect future K-lines through its input.
- **REQ-015**: The runner shall convert accepted strategy decisions into `BacktestTrade` records.
- **REQ-016**: The runner shall reject invalid decisions without crashing the backtest.
- **REQ-017**: The runner shall isolate strategy errors and return a backtest result with diagnostics instead of breaking the React UI.
- **REQ-018**: The strategy function shall be usable by AI assistants without requiring edits to the backtest runner, chart component, or Supabase utilities.
- **REQ-019**: Strategy IDs shall be stable, unique, lowercase kebab-case strings.
- **REQ-020**: The implementation shall preserve existing `BacktestResult` fields and may add optional fields only when needed for diagnostics.

- **CON-001**: User-defined strategies shall run in the browser bundle as normal TypeScript modules. The project shall not use `eval`, `new Function`, remote code execution, or dynamic code strings for this feature.
- **CON-002**: The runner shall simulate long-only trading. It shall not allow negative cash, negative shares, margin, or short positions.
- **CON-003**: The initial implementation shall execute fills at the current K-line close price.
- **CON-004**: The runner shall clamp order size to available cash for buys and held shares for sells.
- **CON-005**: The runner shall reject `NaN`, `Infinity`, `-Infinity`, zero, and negative order amounts.
- **CON-006**: The runner shall use the same date string format as `Kline.date` for all generated trades.
- **CON-007**: New code shall preserve TypeScript type safety and pass `npm run lint`.

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
src/utils/strategyAdapter.ts
```

Responsibilities:

| File | Responsibility |
| --- | --- |
| `src/types/strategy.ts` | Owns the fixed user-defined strategy interfaces. |
| `src/strategies/user/index.ts` | Exports the registry of user-defined strategies. |
| `src/strategies/user/*.ts` | Contains individual user-defined strategy definitions. |
| `src/utils/strategyAdapter.ts` | Validates strategy definitions and normalizes decisions. |
| `src/utils/backtestRunner.ts` | Iterates over K-lines, calls the selected strategy, simulates fills, and returns a `BacktestResult`. |
| `src/components/BacktestManager.tsx` | Lets users select a strategy, run a backtest, display trades, and save results. |

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
- The strategy shall treat all input objects and arrays as immutable.

### 4.3 Account, Position, and Trade Snapshot Contracts

```ts
export interface BacktestAccountState {
  initialCash: number;
  cash: number;
  equity: number;
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
  requiredIndicators?: readonly RequiredIndicator[];
  requiresChanLun?: boolean;
  decide: UserStrategyFunction;
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
- `requiredIndicators` shall list all indicators the strategy needs, enabling pre-calculation.
- `requiresChanLun` shall be `true` if the strategy uses ChanLun analysis (strokes, segments, hubs).

### 4.5 Decision Contract

```ts
export type UserStrategyAction = 'BUY' | 'SELL' | 'HOLD';

export type UserStrategyAmountUnit =
  | 'cash'
  | 'shares'
  | 'percent';

export interface UserStrategyDecision {
  action: UserStrategyAction;
  amount?: UserStrategyAmount;
  reason?: string;
  confidence?: number;
}

export interface UserStrategyAmount {
  unit: UserStrategyAmountUnit;
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

### 4.6 Registry Contract

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

### 4.7 Backtest Runner Contract

The runner should expose a function with this shape:

```ts
import type { BacktestResult } from '../types/stock';
import type { UserStrategyDefinition } from '../types/strategy';

export interface RunBacktestInput {
  klines: readonly Kline[];
  symbol: string;
  userId: string;
  initialCash: number;
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

## 11. Related Specifications / Further Reading

- [User-Defined Indicator Interface and K-Line Chart Rendering](./spec-design-user-defined-indicators.md)
- [Project README](../README.md)
