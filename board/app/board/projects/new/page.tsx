'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export default function NewProjectPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;

    setUploading(true);
    setError(null);

    for (const file of Array.from(selected)) {
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/uploads', { method: 'POST', body: form });
        if (!res.ok) {
          const data = await res.json();
          setError(data.error ?? 'Upload failed');
          continue;
        }
        const uploaded = await res.json();
        setFiles((prev) => [...prev, uploaded]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      }
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const handleCreate = async () => {
    if (!name.trim()) { setError('Project name is required'); return; }
    if (!brief.trim()) { setError('Brief is required'); return; }

    setCreating(true);
    setError(null);
    setStatus('Creating project...');

    try {
      // 1. Create project
      const projectRes = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: brief.trim(),
          attachments: files,
        }),
      });

      if (!projectRes.ok) {
        const data = await projectRes.json();
        setError(data.error ?? 'Failed to create project');
        setCreating(false);
        return;
      }

      const project = await projectRes.json();
      setStatus('Planning tasks — Kapow is breaking down your brief...');

      // 2. Call planner to break into tasks
      const planRes = await fetch(`/api/projects/${project.id}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief: brief.trim(), attachments: files }),
      });

      if (!planRes.ok) {
        const data = await planRes.json();
        setError(`Planning failed: ${data.error ?? 'unknown'}`);
        // Still redirect — project exists, just no cards yet
        router.push(`/board/projects/${project.id}`);
        return;
      }

      setStatus('Tasks created! Redirecting to project board...');
      router.push(`/board/projects/${project.id}/kanban`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setCreating(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-3">
        <div className="flex items-center gap-4">
          <Link href="/board/projects" className="text-gray-400 hover:text-white text-sm">
            ← Projects
          </Link>
          <h1 className="text-lg font-semibold">New Project</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-6 space-y-6">
        {/* Name */}
        <div>
          <label className="text-xs text-gray-500 uppercase tracking-wide">Project Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. CSU Campaign Website"
            className="w-full mt-1 bg-gray-900 border border-gray-800 rounded-md px-3 py-2 text-white focus:border-blue-500 focus:outline-none"
            disabled={creating}
          />
        </div>

        {/* Brief */}
        <div>
          <label className="text-xs text-gray-500 uppercase tracking-wide">Brief</label>
          <p className="text-xs text-gray-600 mt-0.5 mb-1">
            Describe what you want built. Be specific — Kapow will break this into tasks.
          </p>
          <p className="text-xs text-gray-600 mb-1">
            For QA-only website audits, include a URL and say "No code changes, read-only QA".
          </p>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={8}
            placeholder={"Built in React JS\n\nPut up a very engaging frontpage — think of ways to facilitate engagement\nAdd a blog archive and innerpages\nGenerate and include images\n\nOR\nQA-only website audit for https://example.com\nCheck responsiveness, usability, accessibility, and obvious performance issues.\nNo code changes, read-only QA."}
            className="w-full bg-gray-900 border border-gray-800 rounded-md px-3 py-2 text-white focus:border-blue-500 focus:outline-none resize-none font-mono text-sm"
            disabled={creating}
          />
        </div>

        {/* File Uploads */}
        <div>
          <label className="text-xs text-gray-500 uppercase tracking-wide">Attachments</label>
          <p className="text-xs text-gray-600 mt-0.5 mb-2">
            Images, PDFs, docs — anything Kapow needs for context.
          </p>

          {files.length > 0 && (
            <div className="space-y-2 mb-3">
              {files.map((f) => (
                <div key={f.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-md px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-gray-500">
                      {f.mimeType.startsWith('image/') ? '🖼' : f.mimeType.includes('pdf') ? '📄' : '📎'}
                    </span>
                    <span className="text-sm text-gray-300 truncate">{f.name}</span>
                    <span className="text-xs text-gray-600">{formatSize(f.size)}</span>
                  </div>
                  <button
                    onClick={() => removeFile(f.id)}
                    className="text-xs text-gray-500 hover:text-red-400 ml-2"
                    disabled={creating}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileUpload}
            className="hidden"
            accept="image/*,.pdf,.doc,.docx,.txt,.md,.csv,.json,.xml"
            disabled={creating}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || creating}
            className="px-3 py-1.5 text-sm border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 rounded-md disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : '+ Add Files'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-400/10 border border-red-400/30 rounded-md px-4 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Status */}
        {status && (
          <div className="bg-blue-400/10 border border-blue-400/30 rounded-md px-4 py-2 text-sm text-blue-400 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            {status}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleCreate}
          disabled={creating || !name.trim() || !brief.trim()}
          className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 rounded-lg font-medium transition-colors"
        >
          {creating ? 'Kapow is working...' : 'Create Project & Plan Tasks'}
        </button>

        <p className="text-xs text-gray-600 text-center">
          Kapow will analyze your brief, create a plan, and break it into individual cards on the board.
        </p>
      </main>
    </div>
  );
}
