// ── Conversation State Machine ────────────────────────────────────────
//
//   IDLE → SCOPING → PLANNING → NEGOTIATING → CONFIRMED → BUILDING → DONE
//                  ↑                    │                            │
//                  └────────────────────┘ (user requests changes)   │
//                                                                   ↓
//                                                                FAILED
//

export type ConversationPhase =
  | 'idle'
  | 'scoping'       // user described what they want, extracting scope
  | 'planning'      // calling planner for detailed coverage
  | 'negotiating'   // presenting plan, user can accept/modify/reject
  | 'confirmed'     // user approved, about to start pipeline
  | 'building'      // pipeline running
  | 'done'          // pipeline complete
  | 'failed';       // pipeline or conversation failed

export interface ConversationMessage {
  role: 'user' | 'kapow';
  text: string;
  timestamp: string;
}

export interface ConversationState {
  id: string;
  channelId: string;
  threadTs: string;           // Slack thread timestamp (conversation anchor)
  userId: string;             // Slack user ID
  userName: string;
  phase: ConversationPhase;
  projectName?: string;
  projectId?: string;         // DB project ID once created
  runId?: string;             // Pipeline run ID
  scope?: string;             // Raw user scope description
  plan?: string;              // Formatted plan from planner
  planDetail?: unknown;       // Full ProjectPlan object
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
}

// ── Slack Event Types ────────────────────────────────────────────────

export interface SlackUser {
  id: string;
  name: string;
  realName?: string;
}

// ── Intent Detection ─────────────────────────────────────────────────

export type UserIntent =
  | { type: 'new_project'; scope: string }
  | { type: 'modify_scope'; changes: string }
  | { type: 'approve' }
  | { type: 'reject'; reason?: string }
  | { type: 'check_status' }
  | { type: 'list_projects' }
  | { type: 'help' }
  | { type: 'unknown'; text: string };
