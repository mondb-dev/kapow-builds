interface AgentBadgeProps {
  size?: 'sm' | 'md' | 'lg';
  pulsing?: boolean;
}

export function AgentBadge({ size = 'md', pulsing = false }: AgentBadgeProps) {
  const sizeClasses = {
    sm: 'w-5 h-5',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };

  const iconClasses = {
    sm: 'w-3 h-3',
    md: 'w-3.5 h-3.5',
    lg: 'w-5 h-5',
  };

  return (
    <div className="relative inline-flex">
      <div
        className={`${sizeClasses[size]} rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0`}
        title="Kapow Agent"
      >
        {/* Robot/circuit icon */}
        <svg
          className={`${iconClasses[size]} text-white`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.8}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21M12 9a3 3 0 100 6 3 3 0 000-6z"
          />
        </svg>
      </div>

      {pulsing && (
        <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
        </span>
      )}
    </div>
  );
}
