export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
        <rect width="26" height="26" rx="7" fill="#009966" />
        {/* Three flatiron peaks over a ledger line */}
        <path d="M5 18 L9.5 9 L12 13.5 L14.5 8 L17 13 L18.5 10.5 L21 18 Z" fill="white" opacity="0.95" />
        <rect x="5" y="19.5" width="16" height="1.6" rx="0.8" fill="white" opacity="0.7" />
      </svg>
      <span className="font-display text-[15px] font-semibold tracking-tight text-ink">Flatirons Books</span>
    </div>
  );
}
