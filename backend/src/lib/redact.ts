const EMAIL_PATTERN = /[^\s@<>()[\]{}"',;:]+@[^\s@<>()[\]{}"',;:]+\.[a-z]{2,}/gi;

/**
 * Masks email addresses in text that is about to be logged. Error messages from
 * AWS SDK calls (SES in particular) can echo the recipient address back.
 */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '[email]');
}
