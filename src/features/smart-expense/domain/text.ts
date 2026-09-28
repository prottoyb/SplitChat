/** Text normalisation shared by the interpreter's modules. */


/** NFKC, typographic apostrophes, no zero-width or bidi controls, single spaces. */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "")
    .replace(/\s+/g, ' ')
    .trim()
}

/** A word lowercased without surrounding punctuation or a leading @. */
export const bare = (token: string) => token.toLowerCase().replace(/^[("'@]+|[)"'.,;:!?]+$/g, '')
