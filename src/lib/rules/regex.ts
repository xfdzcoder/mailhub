import { RE2JS } from 're2js';

export const MAX_RULE_PATTERN_LENGTH = 1024;
export const MAX_RULE_CRITERIA = 50;
export const MAX_RULE_REGEX_INPUT_LENGTH = 1_000_000;
const MAX_COMPILED_PATTERNS = 128;
const compiledPatterns = new Map<string, RE2JS>();

function compile(pattern: string): RE2JS {
  if (pattern.length > MAX_RULE_PATTERN_LENGTH) {
    throw new Error(`Regular expressions must be at most ${MAX_RULE_PATTERN_LENGTH} characters.`);
  }
  const cached = compiledPatterns.get(pattern);
  if (cached) return cached;
  const compiled = RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
  if (compiledPatterns.size >= MAX_COMPILED_PATTERNS) {
    const oldest = compiledPatterns.keys().next().value;
    if (oldest !== undefined) compiledPatterns.delete(oldest);
  }
  compiledPatterns.set(pattern, compiled);
  return compiled;
}

/** Shared by API validation, legacy-rule status, and automatic evaluation. */
export function getRuleRegexError(conditions: unknown): string | null {
  if (!conditions || typeof conditions !== 'object') return null;
  const criteria = (conditions as { criteria?: unknown }).criteria;
  if (!Array.isArray(criteria)) return null;
  if (criteria.length > MAX_RULE_CRITERIA) {
    return `Rules may contain at most ${MAX_RULE_CRITERIA} criteria.`;
  }
  for (const criterion of criteria) {
    if (!criterion || typeof criterion !== 'object' || criterion.operator !== 'matches_regex') continue;
    if (typeof criterion.value !== 'string') return 'A regular expression must be a string.';
    try {
      compile(criterion.value);
    } catch {
      return `Unsupported regular expression. Use RE2-compatible syntax with at most ${MAX_RULE_PATTERN_LENGTH} characters.`;
    }
  }
  return null;
}

export function testRuleRegex(pattern: string, input: string): boolean {
  if (input.length > MAX_RULE_REGEX_INPUT_LENGTH) return false;
  try {
    return compile(pattern).test(input);
  } catch {
    return false;
  }
}

export function withRuleRegexStatus<T extends { conditions: unknown; isActive: boolean }>(rule: T) {
  const validationError = getRuleRegexError(rule.conditions);
  return { ...rule, isActive: validationError ? false : rule.isActive, validationError };
}
