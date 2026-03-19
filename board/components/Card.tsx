'use client';

import { useRouter } from 'next/navigation';
import { AgentBadge } from './AgentBadge';

type CardStatus = 'BACKLOG' | 'IN_PROGRESS' | 'QA' | 'DONE' | 'FAILED';
type AssigneeType = 'UNASSIGNED' | 'HUMAN' | 'AGENT';

interface CardUser {
  id: string;
  name: string | null;
  image: string | null;
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
  _count: { events: number };
}

interface CardProps {
  card: CardData;
  onDragStart: (cardId: string) => void;
}

const statusBadgeColors: Record<CardStatus, string> = {
  BACKLOG: 'bg-gray-800 text-gray-400',
  IN_PROGRESS: 'bg-blue-900/50 text-blue-300',
  QA: 'bg-amber-900/50 text-amber-300',
  DONE: 'bg-green-900/50 text-green-300',
  FAILED: 'bg-red-900/50 text-red-300',
};

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function Card({ card, onDragStart }: CardProps) {
  const router = useRouter();
  const isPulsing = card.assigneeType === 'AGENT' && card.status === 'IN_PROGRESS';

  return (
    <div
      draggable
      onDragStart={() => onDragStart(card.id)}
      onClick={() => router.push(`/board/${card.id}`)}
      className="bg-gray-900 border border-gray-800 rounded-xl p-3.5 cursor-pointer hover:border-gray-600 hover:bg-gray-800/80 transition-all duration-150 group select-none"
    >
      {/* Title */}
      <p className="text-sm font-medium text-gray-100 leading-snug line-clamp-2 group-hover:text-white transition-colors">
        {card.title}
      </p>

      {/* Description preview */}
      <p className="mt-1 text-xs text-gray-500 line-clamp-2 leading-relaxed">
        {card.description}
      </p>

      {/* Links row */}
      {(card.repoUrl || card.deployUrl) && (
        <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {card.repoUrl && (
            <a
              href={card.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-blue-400 transition-colors"
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              repo
            </a>
          )}
          {card.deployUrl && (
            <a
              href={card.deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-green-400 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              deploy
            </a>
          )}
        </div>
      )}

      {/* Footer: assignee + date + event count */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {card.assigneeType === 'AGENT' ? (
            <AgentBadge size="sm" pulsing={isPulsing} />
          ) : card.assigneeType === 'HUMAN' && card.assignee ? (
            card.assignee.image ? (
              <img
                src={card.assignee.image}
                alt={card.assignee.name ?? ''}
                className="w-5 h-5 rounded-full border border-gray-700"
              />
            ) : (
              <div className="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center text-xs text-gray-300">
                {(card.assignee.name ?? '?')[0].toUpperCase()}
              </div>
            )
          ) : (
            <div className="w-5 h-5 rounded-full border border-dashed border-gray-700 flex items-center justify-center">
              <svg className="w-3 h-3 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
              </svg>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {card._count.events > 0 && (
            <span className="flex items-center gap-1 text-xs text-gray-600">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
              {card._count.events}
            </span>
          )}
          <span className="text-xs text-gray-600">{formatDate(card.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}
