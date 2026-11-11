/**
 * Untrusted text goes to the model inside a named tag. Every `<` inside is escaped, so the text can
 * never write the closing tag and continue as if it were the prompt.
 */
export const taggedText = (tag: string, text: string): string =>
  `<${tag}>\n${text.replaceAll('<', '&lt;')}\n</${tag}>`;

/** The same for data shown as JSON; `\u003c` decodes back to `<`, so the JSON means the same. */
export const taggedJson = (tag: string, value: unknown): string =>
  `<${tag}>\n${JSON.stringify(value, null, 2).replaceAll('<', '\\u003c')}\n</${tag}>`;
