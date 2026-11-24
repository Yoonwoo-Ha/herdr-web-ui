const NAME = "\\p{L}\\p{N}\\p{M}_";
// Match the character before the link as well, without lookbehind. Group 1 is the link, group 2 its path.
const FILE_PATH = new RegExp(`(?:^|[^${NAME}/.@~:-])(((?:~\\/|\\.{1,2}\\/|\\/)?(?:[${NAME}@.+-]+\\/)*[${NAME}@+-][${NAME}@.+-]*\\.[A-Za-z0-9]{1,8})(?::\\d+(?::\\d+)?|#L\\d+(?:-L?\\d+)?)?)(?![${NAME}/])`, "gu");
const CALL = /\s*\((?!\d+(?:,\d+)?\))/y;

/** URI schemes the browser considers web links. Copy hints show the same schemes without opening them. */
export function isWebLink(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/** URI spans that must not also be mistaken for paths. */
export function addressSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let end = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", end)) {
    let start = at;
    while (start > end && !/\s/.test(text.charAt(start - 1))) start--;
    end = at + 3;
    while (end < text.length && !/\s/.test(text.charAt(end))) end++;
    spans.push([start, end]);
  }
  return spans;
}

export function* terminalPathMatches(text: string, bare: boolean) {
  const spans = addressSpans(text);
  let span = 0;
  for (const found of text.matchAll(FILE_PATH)) {
    const [, link, path] = found;
    if (!link || !path) continue;
    const index = found.index + found[0].length - link.length;
    const folder = path.includes("/");
    if ((!folder && !bare) || !/\p{L}/u.test(path.replace(/\.[A-Za-z0-9]{1,8}$/, ""))) continue;
    if (/^v?\d+(?:\.\d+)+$/.test(path)) continue;
    CALL.lastIndex = index + link.length;
    if (CALL.test(text)) continue;
    let current = spans[span];
    while (current && current[1] <= index) current = spans[++span];
    if (current && current[0] <= index) continue;
    yield { index, link, path, folder };
  }
}
