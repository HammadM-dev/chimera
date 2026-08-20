// Turning a web page into what it says.
//
// A page fetched for research is mostly markup, scripts and styling: 200,000
// characters of HTML is about fifty thousand tokens, and almost none of it is
// the thing the agent was sent to find. Stripping it is the single largest
// saving available on a research run, and it makes what does arrive readable.
//
// Deliberately not a parser. A DOM library would be more faithful and would be
// a dependency, a parse step and an attack surface for the sake of output that
// is going to be read by a language model — which does not need well-formed
// anything.

const DROPPED = ['script', 'style', 'noscript', 'svg', 'head'];

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

export function htmlToText(html: string): string {
  let text = html;

  for (const tag of DROPPED) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }

  // Structure that carries meaning becomes whitespace that carries the same
  // meaning: a list stays a list, a paragraph stays a paragraph.
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|tr|li|ul|ol|table)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/t[dh]>/gi, '\t');

  text = text.replace(/<[^>]+>/g, ' ');

  for (const [entity, character] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(character);
  }
  text = text.replace(/&#(\d+);/g, (_all, code: string) =>
    String.fromCharCode(Number.parseInt(code, 10)),
  );

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
