/**
 * Channel Adapter Interface
 *
 * Every communication platform (Slack, Discord, Teams, webhook)
 * implements this interface. The handler doesn't know or care
 * which platform it's talking to.
 */

export interface ChannelFile {
  name: string;
  mimeType: string;
  size: number;
  url?: string;            // Platform URL (e.g. Slack file permalink)
  content?: Buffer;        // Raw content (from webhook uploads)
}

export interface ChannelMessage {
  channelId: string;
  threadId: string;       // Thread/conversation anchor
  userId: string;
  userName: string;
  text: string;
  files?: ChannelFile[];  // Attached files/images
  raw?: unknown;          // Platform-specific raw event
}

export interface ChannelReply {
  text: string;
  format?: 'plain' | 'markdown' | 'slack' | 'discord';
  blocks?: unknown[];     // Platform-specific rich blocks
  files?: ChannelFile[];  // Files to attach to the reply
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

  /** Upload a file to a channel/thread (optional — not all platforms support this) */
  uploadFile?(channelId: string, threadId: string, file: ChannelFile): Promise<string | null>;

  /** Download a file from a platform-specific URL (optional) */
  downloadFile?(url: string): Promise<Buffer | null>;

  /** Check if the adapter is connected and healthy */
  isHealthy(): boolean;
}
