/** Логотип панели; compact - только знак, без подписи. */
export function Logo({ size = 28, compact = false }: { size?: number; compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img
        src="/icon.svg"
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className="shrink-0 rounded-lg"
        style={{ width: size, height: size }}
      />
      {!compact && <div className="logo-text font-semibold">VPS Panel</div>}
    </div>
  );
}
