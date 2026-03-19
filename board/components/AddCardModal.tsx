'use client';

import { useState } from 'react';

interface AddCardModalProps {
  onClose: () => void;
  onCreated: (card: unknown) => void;
  currentUserId: string;
}

export function AddCardModal({ onClose, onCreated, currentUserId }: AddCardModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignToAgent, setAssignToAgent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  void currentUserId; // may be used for future "assign to me" logic

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Failed to create card');
        return;
      }

      const card = await res.json();

      if (assignToAgent) {
        const assignRes = await fetch(`/api/cards/${card.id}/assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assigneeType: 'AGENT' }),
        });

        if (assignRes.ok) {
          const assigned = await assignRes.json();
          onCreated(assigned);
        } else {
          onCreated(card);
        }
      } else {
        onCreated(card);
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div className="relative w-full max-w-lg bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-base font-semibold text-white">New Card</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-500 hover:text-gray-300 transition-colors rounded-lg hover:bg-gray-800"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="text-sm text-red-400 bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="card-title" className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
              Title
            </label>
            <input
              id="card-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be built?"
              required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="card-desc" className="block text-xs font-medium text-gray-400 uppercase tracking-wider">
              Description / Plan
            </label>
            <p className="text-xs text-gray-600">
              If assigning to the agent, this is the full plan it receives. Be specific.
            </p>
            <textarea
              id="card-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the feature, requirements, acceptance criteria..."
              required
              rows={8}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors resize-none font-mono leading-relaxed"
            />
          </div>

          {/* Assign to agent checkbox */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative flex items-center mt-0.5">
              <input
                type="checkbox"
                checked={assignToAgent}
                onChange={(e) => setAssignToAgent(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-4 h-4 rounded border border-gray-600 peer-checked:bg-blue-600 peer-checked:border-blue-600 transition-colors flex items-center justify-center">
                {assignToAgent && (
                  <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </div>
            </div>
            <div>
              <span className="text-sm text-gray-300 group-hover:text-white transition-colors">
                Assign to Kapow Agent immediately
              </span>
              <p className="text-xs text-gray-600 mt-0.5">
                Triggers the kapow-actions pipeline right after creation.
              </p>
            </div>
          </label>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !title.trim() || !description.trim()}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
            >
              {loading ? 'Creating...' : assignToAgent ? 'Create + Assign to Agent' : 'Create Card'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
