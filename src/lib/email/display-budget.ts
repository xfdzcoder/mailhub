// Historical mail may predate ingestion limits. Never parse an unbounded body.
export const MAX_MAIL_HTML_LENGTH = 1024 * 1024;
export const MAX_INLINE_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_DATA_LENGTH = 14 * 1024 * 1024;
export const MAX_MAIL_IMAGES = 256;
