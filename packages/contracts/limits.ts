// Character limits use JavaScript string.length (UTF-16 code units), not tokens.
export const CHAT_LIMITS = Object.freeze({
  inputCharacters: 30_000,
  attachmentsPerMessage: 5,
  attachmentNameCharacters: 200,
  attachmentFileBytes: 100_000,
  attachmentCharacters: 100_000,
  contextCharacters: 240_000,
  responseCharacters: 200_000,
  generationMilliseconds: 180_000,
  backupBytes: 20 * 1024 * 1024,
});
