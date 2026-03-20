'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  projectId: string;
  count: number;
}

export function AssignAllButton({ projectId, count }: Props) {
  const [assigning, setAssigning] = useState(false);
  const router = useRouter();

  const handleAssignAll = async () => {
    if (!confirm(`Start work on ${count} planned cards? Kapow will follow the planner's sequence.`)) return;

    setAssigning(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/assign-all`, {
        method: 'POST',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? 'Failed to start work');
        return;
      }

      const data = await res.json();
      alert(`Kapow started work on ${data.started} cards in planner order.`);
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed');
    } finally {
      setAssigning(false);
    }
  };

  return (
    <button
      onClick={handleAssignAll}
      disabled={assigning}
      className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 rounded-md font-medium transition-colors flex items-center gap-2"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      {assigning ? 'Starting...' : `Start Work (${count})`}
    </button>
  );
}
