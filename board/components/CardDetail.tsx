'use client';

import { useState, useEffect, useRef } from 'react';
import { AgentBadge } from './AgentBadge';

type CardStatus = 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED';
type AssigneeType = 'UNASSIGNED' | 'HUMAN' | 'AGENT';
type EventType = 'INFO' | 'SUCCESS' | 'ERROR' | 'PROGRESS';

interface CardUser {
  id: string;
  name: string | null;
  image: string | null;
}

interface CardEventData {
  id: string;
  cardId: string;
  message: string;
  type: EventType;
  createdAt: string;
}

interface CardData {
  id: string;
  title: string;
  description: string;
  status: CardStatus;
  assigneeType: AssigneeType;
  assignee: CardUser | null;
  creator: CardUser;
  repoUrl: string | null;
  deployUrl: string | null;
  runId: string | null;
  createdAt: string;
  events: CardEventData[];
}

interface CardDetailProps {
  card: CardData;
  currentUserId: string;
  currentUserName: string;
  currentUserImage: string | null;
}

const statusColors: Record<CardStatus, string> = {
  BACKLOG: 'bg-gray-800 text-gray-300 border-gray-700',
  IN_PROGRESS: 'bg-blue-900/40 text-blue-300 border-blue-800/50',
  QA: 'bg-amber-900/40 text-amber-300 border-amber-800/50',
  DONE: 'bg-green-900/40 text-green-300 border-green-800/50',
  FAILED: 'bg-red-900/40 text-red-300 border-red-800/50',
};

const eventTypeStyles: Record<EventType, string> = {
  INFO: 'text-gray-400',
  PROGRESS: 'text-blue-400',
  SUCCESS: 'text-green-400',
  ERROR: 'text-red-400',
};

const eventTypeDot: Record<EventType, string> = {
  INFO: 'bg-gray-600',
  PROGRESS: 'bg-blue-500',
  SUCCESS: 'bg-green-500',
  ERROR: 'bg-red-500',
};

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function CardDetail({ card: initialCard, currentUserId, currentUserName, currentUserImage }: CardDetailProps) {
  const [card, setCard] = useState(initialCard);
  const [events, setEvents] = useState<CardEventData[]>(initialCard.events);
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const eventsEndRef = useRef<HTMLDivElement>(null);

  void currentUserName;
  void currentUserImage;

  // Auto-scroll events
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  // SSE: stream new events
  useEffect(() => {
    const es = new EventSource(`/api/cards/${card.id}/events`);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'connected' || data.type === 'heartbeat') return;

        // It's a CardEvent — add if not already present
        setEvents((prev) => {
          if (prev.some((ev) => ev.id === data.id)) return prev;
          return [...prev, data as CardEventData];
        });

        // If status changed on the event side, re-fetch card
        if (data.type === 'SUCCESS' || data.type === 'ERROR') {
          fetch(`/api/cards/${card.id}`)
            .then((r) => r.json())
            .then((updated) => setCard(updated))
            .catch(() => {});
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // SSE will auto-reconnect
    };

    return () => es.close();
  }, [card.id]);

  async function handleAssign(type: 'AGENT' | 'HUMAN') {
    setAssigning(true);
    setAssignError(null);

    try {
      const body: Record<string, unknown> = { assigneeType: type };
      if (type === 'HUMAN') body.userId = currentUserId;

      const res = await fetch(`/api/cards/${card.id}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        setAssignError(data.error ?? 'Assignment failed');
        return;
      }

      const updated = await res.json();
      setCard(updated);
    } catch (err) {
      setAssignError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setAssigning(false);
    }
  }

  const isAgentRunning = card.assigneeType === 'AGENT' && card.status === 'IN_PROGRESS';

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      {/* Title + status */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-white leading-tight">{card.title}</h1>
          <span className={`flex-shrink-0 text-xs font-medium px-2.5 py-1 rounded-lg border ${statusColors[card.status]}`}>
            {card.status.replace('_', ' ')}
          </span>
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span>Created {formatDateTime(card.createdAt)}</span>
          {card.creator && (
            <span>by {card.creator.name ?? 'Unknown'}</span>
          )}
        </div>
      </div>

      {/* Description */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Description / Plan</h2>
        <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
          {card.description}
        </pre>
      </div>

      {/* Assignee + actions */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Assignee</h2>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {card.assigneeType === 'AGENT' ? (
              <>
                <AgentBadge size="md" pulsing={isAgentRunning} />
                <div>
                  <p className="text-sm font-medium text-white">Kapow Agent</p>
                  {card.runId && (
                    <p className="text-xs text-gray-600 font-mono">run: {card.runId.slice(0, 12)}...</p>
                  )}
                </div>
              </>
            ) : card.assigneeType === 'HUMAN' && card.assignee ? (
              <>
                {card.assignee.image ? (
                  <img src={card.assignee.image} alt="" className="w-6 h-6 rounded-full border border-gray-700" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-xs text-gray-300">
                    {(card.assignee.name ?? '?')[0].toUpperCase()}
                  </div>
                )}
                <p className="text-sm font-medium text-white">{card.assignee.name ?? 'Unknown'}</p>
              </>
            ) : (
              <p className="text-sm text-gray-500">Unassigned</p>
            )}
          </div>

          {/* Action buttons */}
          {card.assigneeType === 'UNASSIGNED' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleAssign('HUMAN')}
                disabled={assigning}
                className="px-3 py-1.5 text-xs font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg disabled:opacity-50 transition-colors"
              >
                Assign to me
              </button>
              <button
                onClick={() => handleAssign('AGENT')}
                disabled={assigning}
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                <AgentBadge size="sm" />
                Assign to Agent
              </button>
            </div>
          )}

          {card.assigneeType === 'HUMAN' && card.assigneeId !== currentUserId && (
            <button
              onClick={() => handleAssign('HUMAN')}
              disabled={assigning}
              className="px-3 py-1.5 text-xs font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg disabled:opacity-50 transition-colors"
            >
              Assign to me instead
            </button>
          )}

          {card.assigneeType === 'HUMAN' && (
            <button
              onClick={() => handleAssign('AGENT')}
              disabled={assigning}
              className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              <AgentBadge size="sm" />
              Send to Agent
            </button>
          )}
        </div>

        {assignError && (
          <p className="text-xs text-red-400">{assignError}</p>
        )}
      </div>

      {/* Links */}
      {(card.repoUrl || card.deployUrl) && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Links</h2>
          <div className="flex flex-col gap-2">
            {card.repoUrl && (
              <a
                href={card.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 transition-colors"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                {card.repoUrl}
              </a>
            )}
            {card.deployUrl && (
              <a
                href={card.deployUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-green-400 hover:text-green-300 transition-colors"
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
                {card.deployUrl}
              </a>
            )}
          </div>
        </div>
      )}

      {/* Activity log */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Activity</h2>
          {isAgentRunning && (
            <span className="flex items-center gap-1.5 text-xs text-blue-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
              Live
            </span>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto p-5 space-y-3">
          {events.length === 0 ? (
            <p className="text-sm text-gray-600 text-center py-4">No activity yet.</p>
          ) : (
            events.map((event) => (
              <div key={event.id} className="flex items-start gap-2.5">
                <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${eventTypeDot[event.type]}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-xs leading-relaxed ${eventTypeStyles[event.type]}`}>
                    {event.message}
                  </p>
                  <p className="text-xs text-gray-700 mt-0.5">{formatDateTime(event.createdAt)}</p>
                </div>
              </div>
            ))
          )}
          <div ref={eventsEndRef} />
        </div>
      </div>
    </div>
  );
}
