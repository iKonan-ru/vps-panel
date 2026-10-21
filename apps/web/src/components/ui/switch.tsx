import { cn } from '@/lib/cn';

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  className,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'gloss-primary bg-accent' : 'well bg-border',
        className,
      )}
    >
      <span
        className={cn(
          'size-5 rounded-full bg-white bg-linear-to-b from-white to-[#e9edf2] shadow-[0_1px_3px_rgb(0_0_0/0.35)] transition-transform duration-200 ease-out motion-reduce:transition-none',
          checked && 'translate-x-5',
        )}
      />
    </button>
  );
}
