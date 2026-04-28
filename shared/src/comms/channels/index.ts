/**
 * Channel Adapters
 *
 * Each file in this directory is a self-contained integration
 * implementing the OutputChannel interface. To add a new channel:
 *
 * 1. Create a new file here (e.g. discord.ts)
 * 2. Implement OutputChannel from ../types.ts
 * 3. Export it from this index
 * 4. Add env-var loading in pipeline/src/comms-config.ts
 */
export { BoardChannel } from './board.js';
export { SlackOutputChannel, type SlackOutputChannelConfig } from './slack.js';
export { TelegramChannel, type TelegramChannelConfig } from './telegram.js';
export { WebhookChannel } from './webhook.js';
