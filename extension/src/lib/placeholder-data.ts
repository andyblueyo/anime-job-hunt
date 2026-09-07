// Every fake value the extension's UI renders, in one place. These exist
// because the restyle builds elements the backend doesn't have data for
// yet; each one is a default prop on the component that shows it, so wiring
// a real value means replacing that default and deleting the entry here.
//
// Anything rendered from this module carries a `data-demo` attribute (a small
// mono DEMO tag), so a fake value can't be misread as a live one.

/**
 * Lock overlay: the note beside the Snooze button.
 * TODO: wire to a daily snooze cap once one exists. No cap exists today —
 * snoozes are unlimited-but-tracked via unlock_sessions.snooze_count — and a
 * cap changes what the tool is, so decide it deliberately rather than
 * letting this mockup copy make the call.
 */
export const PLACEHOLDER_SNOOZE_NOTE = "1 snooze left today";

/**
 * Popup footer: "queue • N open".
 * TODO: wire to a queue count from the website (no route returns one yet;
 * GET /api/extension-config is the natural place).
 */
export const PLACEHOLDER_QUEUE_OPEN_COUNT = 8;
