jest.mock('@/lib/email/attachment-retrieval', () => ({ getReceivedAttachment: jest.fn() }));
import { evaluateCriterion, evaluateRule } from '@/lib/rules/engine';
import { getRuleRegexError, MAX_RULE_PATTERN_LENGTH, MAX_RULE_REGEX_INPUT_LENGTH, testRuleRegex, withRuleRegexStatus } from '@/lib/rules/regex';
import type { EmailRuleDefinition } from '@/lib/rules/types';

it('uses case-insensitive substring search, preserving escaped character classes', () => {
  expect(evaluateCriterion({ subject: 'New INVOICE-42 received' }, {
    field: 'subject', operator: 'matches_regex', value: 'invoice-[0-9]+',
  })).toBe(true);
  expect(evaluateCriterion({ subject: '123' }, { field: 'subject', operator: 'matches_regex', value: '\\D+' })).toBe(false);
  expect(testRuleRegex('^invoice$', 'new invoice')).toBe(false);
});
it.each(['(?=invoice)invoice', '(invoice)\\1', '[', 'x'.repeat(MAX_RULE_PATTERN_LENGTH + 1)])('rejects unsupported or oversized patterns', pattern => {
  expect(getRuleRegexError({ matchType: 'ALL', criteria: [{ operator: 'matches_regex', value: pattern }] })).not.toBeNull();
  expect(testRuleRegex(pattern, 'invoice')).toBe(false);
});
it('disables an entire incompatible legacy rule even when another ANY condition matches', () => {
  const rule: EmailRuleDefinition = {
    name: 'Legacy fixture', isActive: true, priority: 0,
    conditions: { matchType: 'ANY', criteria: [
      { field: 'subject', operator: 'contains', value: 'invoice' },
      { field: 'subject', operator: 'matches_regex', value: '(invoice)\\1' },
    ] }, actions: { markAsRead: true },
  };
  expect(evaluateRule({ subject: 'invoice' }, rule)).toBe(false);
  expect(withRuleRegexStatus(rule)).toMatchObject({ isActive: false, validationError: expect.any(String) });
  expect(rule.isActive).toBe(true); // Effective status does not rewrite stored user configuration.
});
it('bounds criteria and matching input without truncating content', () => {
  expect(getRuleRegexError({ criteria: Array.from({ length: 51 }, () => ({ operator: 'contains', value: 'invoice' })) })).not.toBeNull();
  expect(testRuleRegex('x$', 'x'.repeat(MAX_RULE_REGEX_INPUT_LENGTH + 1))).toBe(false);
  expect(testRuleRegex('invoice-[0-9]+', 'x'.repeat(100_000) + 'INVOICE-42')).toBe(true);
});
it('preserves compatible active and manually paused rules', () => {
  const conditions = { matchType: 'ALL', criteria: [{ field: 'subject', operator: 'matches_regex', value: '^invoice' }] };
  expect(withRuleRegexStatus({ conditions, isActive: true })).toMatchObject({ isActive: true, validationError: null });
  expect(withRuleRegexStatus({ conditions, isActive: false })).toMatchObject({ isActive: false, validationError: null });
});
