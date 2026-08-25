/**
 * Escape user-controlled text before interpolating it into Slack `mrkdwn`.
 * Slack's own escaping rule: & -> &amp;, < -> &lt;, > -> &gt;. This must be applied to
 * any employee name, department, note, or free-text field placed into a `mrkdwn` string;
 * it must NOT be applied to markdown we author ourselves (e.g. our own literal `*bold*`).
 */
export function escapeMrkdwn(input: string | null | undefined): string {
  if (!input) return '';
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Truncate to Slack's per-block text limits (3000 chars for section text) with an ellipsis. */
export function truncateForBlock(input: string, max = 2900): string {
  if (input.length <= max) return input;
  return input.slice(0, max - 1) + '…';
}
