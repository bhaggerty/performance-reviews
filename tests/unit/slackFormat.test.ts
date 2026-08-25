import { describe, it, expect } from 'vitest';
import { escapeMrkdwn, truncateForBlock } from '../../src/domain/slackFormat';

describe('escapeMrkdwn', () => {
  it('escapes &, <, and > together without double-escaping', () => {
    expect(escapeMrkdwn('A & B <C> & D')).toBe('A &amp; B &lt;C&gt; &amp; D');
  });

  it('leaves a string with none of the special characters untouched', () => {
    expect(escapeMrkdwn('Plain text, no specials')).toBe('Plain text, no specials');
  });

  it('returns an empty string for null/undefined/empty input', () => {
    expect(escapeMrkdwn(null)).toBe('');
    expect(escapeMrkdwn(undefined)).toBe('');
    expect(escapeMrkdwn('')).toBe('');
  });

  it('escapes ampersand first so &lt; is not re-escaped into &amp;lt;', () => {
    expect(escapeMrkdwn('<')).toBe('&lt;');
    expect(escapeMrkdwn('&lt;')).toBe('&amp;lt;');
  });
});

describe('truncateForBlock', () => {
  it('returns the input unchanged when at or under the max', () => {
    expect(truncateForBlock('short', 10)).toBe('short');
    expect(truncateForBlock('x'.repeat(10), 10)).toBe('x'.repeat(10));
  });

  it('truncates and appends an ellipsis when over the max', () => {
    const result = truncateForBlock('x'.repeat(20), 10);
    expect(result.length).toBe(10);
    expect(result.endsWith('…')).toBe(true);
  });

  it('defaults to a 2900 character max', () => {
    const result = truncateForBlock('y'.repeat(3000));
    expect(result.length).toBe(2900);
  });
});
