import { config } from "../../package.json";

/**
 * Event name used to request opening or focusing the assistant popout window.
 */
export const ASSISTANT_POPOUT_REQUEST_EVENT = `${config.addonRef}-assistant-popout-request`;

/**
 * Event name emitted when the assistant popout window open state changes.
 */
export const ASSISTANT_POPOUT_STATE_EVENT = `${config.addonRef}-assistant-popout-state-change`;
