import type { Kline } from '../types/stock';
import type {
  UserStrategyDefinition,
  UserStrategyDecision,
  UserStrategyAction,
  UserStrategyAmount,
  UserStrategyAmountUnit,
  BacktestAccountState,
  BacktestPositionState,
  StrategyParamValue,
} from '../types/strategy';

// ---------------------------------------------------------------------------
// A-Share fee calculation (佣金 + 印花税 + 过户费)
// ---------------------------------------------------------------------------

/**
 * Calculate transaction fees for A-share trading.
 *   佣金 (commission): tradeValue * commissionRate, with a per-trade minimum
 *   印花税 (stamp duty): tradeValue * 0.001 (0.1%), sell only, government levy
 *   过户费 (transfer fee): tradeValue * 0.00001 (0.001%), both sides
 */
export function calcAStockFees(
  tradeValue: number,
  isBuy: boolean,
  commissionRate: number = 0.00025,
  minCommission: number = 5,
): number {
  let commission = tradeValue * commissionRate;
  if (commission < minCommission) {
    commission = minCommission;
  }

  const stampDuty = isBuy ? 0 : tradeValue * 0.001;

  const transferFee = tradeValue * 0.00001;

  return commission + stampDuty + transferFee;
}

// ---------------------------------------------------------------------------
// Limit up/down detection for A-shares
// ---------------------------------------------------------------------------

/**
 * Determine the limit-up ratio based on stock code prefix.
 *   60xxxx / 000xxx / 002xxx / 001xxx → ±10%  (main board)
 *   300xxx (ChiNext) / 688xxx (STAR)   → ±20%
 *   4xxxxx / 8xxxxx                     → ±5%   (三板 simplified)
 */
export function getStockLimitRatio(symbol: string): number {
  const code = symbol.replace(/\.(SS|SZ|SH|BJ)$/, '').trim();

  if (/^(688|300)/.test(code)) return 1.20;
  if (/^[48]/.test(code)) return 1.05;
  return 1.10;
}

export function getLimitUpPrice(prevClose: number, ratio: number): number {
  return Math.round(prevClose * ratio * 100) / 100;
}

export function getLimitDownPrice(prevClose: number, ratio: number): number {
  return Math.round(prevClose * (2 - ratio) * 100) / 100;
}

/**
 * Check if the stock is at 涨停 (limit-up) — cannot buy.
 */
export function isLimitUp(currentKline: Kline, klines: readonly Kline[], symbol: string = ''): boolean {
  if (klines.length < 2) return false;
  const prevClose = klines[klines.length - 2].close;
  const ratio = getStockLimitRatio(symbol);
  const limitUp = getLimitUpPrice(prevClose, ratio);
  return currentKline.close >= limitUp;
}

/**
 * Check if the stock is at 跌停 (limit-down) — cannot sell.
 */
export function isLimitDown(currentKline: Kline, klines: readonly Kline[], symbol: string = ''): boolean {
  if (klines.length < 2) return false;
  const prevClose = klines[klines.length - 2].close;
  const ratio = getStockLimitRatio(symbol);
  const limitDown = getLimitDownPrice(prevClose, ratio);
  return currentKline.close <= limitDown;
}

// ---------------------------------------------------------------------------
// Strategy ID validation
// ---------------------------------------------------------------------------

const STRATEGY_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Validates that a strategy ID follows kebab-case format.
 * Must start with a lowercase letter, followed by lowercase letters/digits,
 * with optional hyphen-separated segments.
 */
export function isValidStrategyId(id: string): boolean {
  return STRATEGY_ID_PATTERN.test(id);
}

// ---------------------------------------------------------------------------
// Strategy params builder
// ---------------------------------------------------------------------------

/**
 * Builds a complete params object by applying default values from the strategy
 * definition, then overriding with any custom params provided.
 */
export function buildStrategyParams(
  definition: UserStrategyDefinition,
  customParams?: Readonly<Record<string, unknown>>
): Record<string, StrategyParamValue> {
  const params: Record<string, StrategyParamValue> = {};

  // Apply defaults from definition
  if (definition.params) {
    for (const param of definition.params) {
      params[param.key] = param.defaultValue;
    }
  }

  // Override with custom params
  if (customParams) {
    for (const [key, value] of Object.entries(customParams)) {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        params[key] = value;
      }
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Decision normalization
// ---------------------------------------------------------------------------

const VALID_ACTIONS: ReadonlySet<UserStrategyAction> = new Set(['BUY', 'SELL', 'HOLD']);
const VALID_UNITS: ReadonlySet<UserStrategyAmountUnit> = new Set(['cash', 'shares', 'percent']);

function isValidAction(value: unknown): value is UserStrategyAction {
  return typeof value === 'string' && VALID_ACTIONS.has(value as UserStrategyAction);
}

function normalizeAmount(amount: unknown): UserStrategyAmount | undefined {
  if (!amount || typeof amount !== 'object') return undefined;

  const obj = amount as Record<string, unknown>;

  let unit: UserStrategyAmountUnit | undefined;
  if (typeof obj.unit === 'string' && VALID_UNITS.has(obj.unit as UserStrategyAmountUnit)) {
    unit = obj.unit as UserStrategyAmountUnit;
  }

  let value: number | undefined;
  if (typeof obj.value === 'number' && Number.isFinite(obj.value)) {
    value = obj.value;
  }

  if (unit === undefined || value === undefined) return undefined;

  // Clamp percent values > 100
  if (unit === 'percent' && value > 100) {
    value = 100;
  }

  return { unit, value };
}

/**
 * Normalizes a raw decision object, ensuring:
 * - action is a valid UserStrategyAction (defaults to HOLD if invalid)
 * - amount is valid for BUY/SELL actions
 * - confidence is clamped between 0 and 1
 */
export function normalizeDecision(decision: Partial<UserStrategyDecision>): UserStrategyDecision {
  const action: UserStrategyAction = isValidAction(decision.action) ? decision.action : 'HOLD';

  let amount: UserStrategyAmount | undefined;
  if (decision.amount !== undefined) {
    amount = normalizeAmount(decision.amount);
  }

  // Remove amount for HOLD
  if (action === 'HOLD') {
    amount = undefined;
  }

  let confidence: number | undefined;
  if (decision.confidence !== undefined) {
    if (typeof decision.confidence === 'number' && Number.isFinite(decision.confidence)) {
      confidence = Math.max(0, Math.min(1, decision.confidence));
    }
  }

  return {
    action,
    ...(amount !== undefined ? { amount } : {}),
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

// ---------------------------------------------------------------------------
// Decision validation
// ---------------------------------------------------------------------------

/**
 * Validates a decision and returns an array of error messages.
 */
export function validateDecision(decision: Partial<UserStrategyDecision>): string[] {
  const errors: string[] = [];

  // Action validation
  if (!isValidAction(decision.action)) {
    errors.push('Action must be BUY, SELL, or HOLD');
    return errors;
  }

  const action = decision.action;

  // Amount validation for BUY/SELL
  if (action === 'BUY' || action === 'SELL') {
    if (!decision.amount || typeof decision.amount !== 'object') {
      errors.push(`${action} must have an amount`);
    } else {
      const obj = decision.amount as unknown as Record<string, unknown>;

      if (!VALID_UNITS.has(obj.unit as UserStrategyAmountUnit)) {
        errors.push('Amount unit must be "cash", "shares", or "percent"');
      }

      if (typeof obj.value !== 'number' || !Number.isFinite(obj.value) || obj.value <= 0) {
        errors.push('Amount value must be a positive finite number');
      } else {
        const unit = obj.unit as UserStrategyAmountUnit;
        const value = obj.value as number;

        if (unit === 'percent' && (value <= 0 || value > 100)) {
          errors.push('Percent value must be > 0 and <= 100');
        }

        if (unit === 'cash' && action === 'SELL') {
          errors.push('Cash unit is only valid for BUY actions');
        }
      }
    }
  }

  // HOLD doesn't need amount
  if (action === 'HOLD' && decision.amount !== undefined) {
    // Not an error, but amount is ignored
  }

  // Confidence validation
  if (decision.confidence !== undefined) {
    if (
      typeof decision.confidence !== 'number' ||
      !Number.isFinite(decision.confidence) ||
      decision.confidence < 0 ||
      decision.confidence > 1
    ) {
      errors.push('Confidence must be a number between 0 and 1');
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Order shares resolution
// ---------------------------------------------------------------------------

export interface ResolvedOrder {
  shares: number;
  actualValue: number;
  warnings: string[];
}

/**
 * Converts a decision's amount to actual shares to trade.
 *
 * Rules:
 * - BUY with cash unit: shares = floor(amount / price), clamped to available cash
 * - BUY with shares unit: shares = amount, clamped to available cash
 * - BUY with percent unit: cashToUse = account.cash * (value / 100), shares = floor(cashToUse / price)
 * - SELL with shares unit: shares = min(amount, position.shares)
 * - SELL with percent unit: shares = floor(position.shares * (value / 100))
 * - SELL with cash unit: invalid, returns 0 shares with warning
 * - Rejects NaN, Infinity, zero, negative amounts
 * - Clamps percent > 100 to 100 with warning
 */
export function resolveOrderShares(
  decision: UserStrategyDecision,
  account: Readonly<BacktestAccountState>,
  position: Readonly<BacktestPositionState>,
  currentPrice: number
): ResolvedOrder {
  const warnings: string[] = [];

  // Validate price
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { shares: 0, actualValue: 0, warnings: ['Invalid current price'] };
  }

  if (decision.action === 'HOLD') {
    return { shares: 0, actualValue: 0, warnings };
  }

  if (!decision.amount) {
    return { shares: 0, actualValue: 0, warnings: ['No amount specified'] };
  }

  const { unit, value } = decision.amount;

  // Reject invalid values
  if (!Number.isFinite(value) || value <= 0) {
    return { shares: 0, actualValue: 0, warnings: ['Amount value must be a positive finite number'] };
  }

  // Clamp percent > 100
  let effectiveValue = value;
  if (unit === 'percent' && value > 100) {
    warnings.push(`Percent value ${value} clamped to 100`);
    effectiveValue = 100;
  }

  if (decision.action === 'BUY') {
    let shares: number;

    switch (unit) {
      case 'cash': {
        const cashToUse = Math.min(effectiveValue, account.cash);
        shares = Math.floor(cashToUse / currentPrice);
        break;
      }
      case 'shares': {
        const maxAffordable = Math.floor(account.cash / currentPrice);
        shares = Math.min(effectiveValue, maxAffordable);
        break;
      }
      case 'percent': {
        const cashToUse = account.cash * (effectiveValue / 100);
        shares = Math.floor(cashToUse / currentPrice);
        break;
      }
      default:
        return { shares: 0, actualValue: 0, warnings: [`Unknown amount unit: ${unit}`] };
    }

    shares = Math.max(0, Math.floor(shares / 100) * 100);
    if (shares <= 0) {
      warnings.push('Buy amount too small for one round lot (100 shares)');
    }
    const actualValue = shares * currentPrice;
    return { shares, actualValue, warnings };
  }

  if (decision.action === 'SELL') {
    let shares: number;

    switch (unit) {
      case 'shares': {
        shares = Math.min(effectiveValue, position.shares);
        break;
      }
      case 'percent': {
        shares = Math.floor(position.shares * (effectiveValue / 100));
        break;
      }
      case 'cash': {
        warnings.push('Cash unit is not valid for SELL actions');
        return { shares: 0, actualValue: 0, warnings };
      }
      default:
        return { shares: 0, actualValue: 0, warnings: [`Unknown amount unit: ${unit}`] };
    }

    shares = Math.max(0, Math.min(shares, position.shares));
    const actualValue = shares * currentPrice;
    return { shares, actualValue, warnings };
  }

  return { shares: 0, actualValue: 0, warnings };
}
