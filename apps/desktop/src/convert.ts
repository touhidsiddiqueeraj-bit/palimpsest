/**
 * Regex-based markdown <-> HTML conversion (spec: import/export).
 * Deliberately lossy: covers the subset the renderer itself emits.
 */

export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_m, l: string, t: string) => '#'.repeat(+l) + ' ' + t.trim() + '\n\n',
    )
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<del>([\s\S]*?)<\/del>/gi, '~~$1~~')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<img src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)')
    .replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(
      /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_m, b: string) =>
        b
          .split('\n')
          .map((l) => '> ' + l.trim())
          .join('\n') + '\n',
    )
    .replace(/<hr[^>]*>/gi, '\n---\n')
    .replace(/<\/p>|<br\s*\/?>|<pre[^>]*>|<\/pre>|<\/ul>|<\/ol>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  s += '\n';
  return s;
}
