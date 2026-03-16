import { createLogger } from '@raven/shared';

const log = createLogger('condition-evaluator');

const MIN_COMPARISON_PARTS = 3;

/**
 * Safely evaluates a pipeline condition expression against node outputs.
 *
 * Supports expressions like:
 *   "{{ fetch-emails.output.urgentCount > 0 }}"
 *   "{{ node-id.output.field }}"  (truthiness check)
 *   "{{ node-id.output.field == 'value' }}"
 *
 * SECURITY: No dynamic code execution — uses regex-based parsing only.
 */
export function evaluateCondition(
  expression: string,
  nodeOutputs: Record<string, unknown>,
): boolean {
  try {
    // Strip {{ }} wrapper
    const inner = expression
      .replace(/^\{\{\s*/, '')
      .replace(/\s*\}\}$/, '')
      .trim();
    if (!inner) return false;

    // Try comparison operators: >, <, >=, <=, ==, !=
    const comparisonMatch = inner.match(/^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/);

    if (comparisonMatch) {
      const leftExpr = comparisonMatch[1].trim();
      const operator = comparisonMatch[2];
      const rightExpr = comparisonMatch[MIN_COMPARISON_PARTS].trim();

      const left = resolveValue(leftExpr, nodeOutputs);
      const right = resolveValue(rightExpr, nodeOutputs);

      return compareValues(left, right, operator);
    }

    // No comparison operator — truthiness check
    const value = resolveValue(inner, nodeOutputs);
    return Boolean(value);
  } catch (err) {
    log.warn(
      `Condition evaluation failed: ${expression} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// eslint-disable-next-line complexity -- pattern matching over many literal types (string, number, boolean, null, dotted path)
function resolveValue(expr: string, nodeOutputs: Record<string, unknown>): unknown {
  // Check for string literal
  if (/^'[^']*'$/.test(expr) || /^"[^"]*"$/.test(expr)) {
    return expr.slice(1, -1);
  }

  // Check for numeric literal
  const num = Number(expr);
  if (!Number.isNaN(num) && expr !== '') return num;

  // Check for boolean literals
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (expr === 'null' || expr === 'undefined') return null;

  // Resolve dotted path: node-id.output.field.nested
  const parts = expr.split('.');

  // First part is the node ID — look it up in nodeOutputs
  let current: unknown = nodeOutputs[parts[0]];

  for (let i = 1; i < parts.length; i++) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[parts[i]];
  }

  return current;
}

// eslint-disable-next-line complexity -- switch over all comparison operators
function compareValues(left: unknown, right: unknown, operator: string): boolean {
  const leftNum = typeof left === 'number' ? left : Number(left);
  const rightNum = typeof right === 'number' ? right : Number(right);
  const numericComparable = !Number.isNaN(leftNum) && !Number.isNaN(rightNum);

  switch (operator) {
    case '==':
      return left === right || (numericComparable && leftNum === rightNum);
    case '!=':
      return left !== right && (!numericComparable || leftNum !== rightNum);
    case '>':
      return numericComparable && leftNum > rightNum;
    case '<':
      return numericComparable && leftNum < rightNum;
    case '>=':
      return numericComparable && leftNum >= rightNum;
    case '<=':
      return numericComparable && leftNum <= rightNum;
    default:
      return false;
  }
}
