/**
 * Channel Adapter Interface
 *
 * Every communication platform (Slack, Discord, Teams, webhook)
 * implements this interface. The handler doesn't know or care
 * which platform it's talking to.
 */

export interface ChannelMessage {
  channelId: string;
  threadId: string;       // Thread/conversation anchor
  userId: string;
  userName: string;
  text: string;
  raw?: unknown;          // Platform-specific raw event
}

export interface ChannelReply {
  text: string;
  format?: 'plain' | 'markdown' | 'slack' | 'discord';
  blocks?: unknown[];     // Platform-specific rich blocks
}

export interface ChannelAdapter {
  /** Platform name (for logging and routing) */
  readonly platform: string;

  /** Start the adapter (connect to platform, start listening) */
  start(): Promise<void>;

  /** Stop the adapter gracefully */
  stop(): Promise<void>;

  /** Register the message handler (called by the comms service on boot) */
  onMessage(handler: (msg: ChannelMessage) => Promise<ChannelReply[]>): void;

  /** Send a reply to a specific thread */
  reply(channelId: string, threadId: string, reply: ChannelReply): Promise<void>;

  /** Check if the adapter is connected and healthy */
  isHealthy(): boolean;
}
