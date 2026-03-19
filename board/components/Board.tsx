'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card } from './Card';
import { AddCardModal } from './AddCardModal';

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

interface BoardProps {
  initialCards: CardData[];
  currentUserId: string;
  currentUserName: string;
}

const COLUMNS: { status: CardStatus; label: string; color: string; headerColor: string; dotColor: string }[] = [
  { status: 'BACKLOG', label: 'Backlog', color: 'border-gray-700', headerColor: 'text-gray-400', dotColor: 'bg-gray-500' },
  { status: 'IN_PROGRESS', label: 'In Progress', color: 'border-blue-800/60', headerColor: 'text-blue-400', dotColor: 'bg-blue-500' },
  { status: 'QA', label: 'QA', color: 'border-amber-800/60', headerColor: 'text-amber-400', dotColor: 'bg-amber-500' },
  { status: 'DONE', label: 'Done', color: 'border-green-800/60', headerColor: 'text-green-400', dotColor: 'bg-green-500' },
  { status: 'FAILED', label: 'Failed', color: 'border-red-800/60', headerColor: 'text-red-400', dotColor: 'bg-red-500' },
];

export function Board({ initialCards, currentUserId, currentUserName }: BoardProps) {
  const [cards, setCards] = useState<CardData[]>(initialCards);
  const [showAddModal, setShowAddModal] = useState(false);
  const [draggingCardId, setDraggingCardId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<CardStatus | null>(null);

  void currentUserName;

  // Poll every 10s for updates
  const fetchCards = useCallback(async () => {
    try {
      const res = await fetch('/api/cards');
      if (res.ok) {
        const data = await res.json();
        const arr = Array.isArray(data) ? data : data.cards;
        if (Array.isArray(arr)) setCards(arr);
      }
    } catch {
      // silent fail — don't disrupt the UI
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(fetchCards, 10_000);
    return () => clearInterval(interval);
  }, [fetchCards]);

  // Drag handlers
  function handleDragStart(cardId: string) {
    setDraggingCardId(cardId);
  }

  function handleDragOver(e: React.DragEvent, status: CardStatus) {
    e.preventDefault();
    setDragOverStatus(status);
  }

  function handleDragLeave() {
    setDragOverStatus(null);
  }

  async function handleDrop(e: React.DragEvent, status: CardStatus) {
    e.preventDefault();
    setDragOverStatus(null);

    if (!draggingCardId) return;
    const card = cards.find((c) => c.id === draggingCardId);
    if (!card || card.status === status) {
      setDraggingCardId(null);
      return;
    }

    // Optimistic update
    setCards((prev) =>
      prev.map((c) => (c.id === draggingCardId ? { ...c, status } : c))
    );
    setDraggingCardId(null);

    try {
      await fetch(`/api/cards/${draggingCardId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch {
      // Revert on error
      fetchCards();
    }
  }

  function handleDragEnd() {
    setDraggingCardId(null);
    setDragOverStatus(null);
  }

  function handleCardCreated(card: unknown) {
    setCards((prev) => [card as CardData, ...prev]);
  }

  const cardsByStatus = (status: CardStatus) => cards.filter((c) => c.status === status);

  return (
    <div className="flex-1 overflow-x-auto overflow-y-hidden px-6 py-5">
      <div className="flex gap-4 h-full min-w-max">
        {COLUMNS.map((col) => {
          const colCards = cardsByStatus(col.status);
          const isDragTarget = dragOverStatus === col.status;

          return (
            <div
              key={col.status}
              className="flex flex-col w-72 flex-shrink-0"
              onDragOver={(e) => handleDragOver(e, col.status)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.status)}
              onDragEnd={handleDragEnd}
            >
              {/* Column header */}
              <div className="flex items-center justify-between mb-3 px-1">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${col.dotColor}`} />
                  <span className={`text-xs font-semibold uppercase tracking-wider ${col.headerColor}`}>
                    {col.label}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-600 tabular-nums">
                    {colCards.length}
                  </span>
                  {col.status === 'BACKLOG' && (
                    <button
                      onClick={() => setShowAddModal(true)}
                      className="p-0.5 text-gray-600 hover:text-blue-400 transition-colors rounded"
                      title="Add card"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Cards container */}
              <div
                className={`flex-1 overflow-y-auto space-y-2.5 rounded-xl border ${col.color} ${
                  isDragTarget ? 'ring-2 ring-blue-500 ring-inset bg-blue-950/10' : 'bg-gray-950/30'
                } p-2.5 transition-all duration-150 min-h-32`}
              >
                {colCards.length === 0 && (
                  <div className="flex items-center justify-center h-24 text-xs text-gray-700">
                    {isDragTarget ? 'Drop here' : 'Empty'}
                  </div>
                )}
                {colCards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    onDragStart={handleDragStart}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {showAddModal && (
        <AddCardModal
          onClose={() => setShowAddModal(false)}
          onCreated={handleCardCreated}
          currentUserId={currentUserId}
        />
      )}
    </div>
  );
}
