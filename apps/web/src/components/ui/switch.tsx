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
        'group flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'gloss-primary bg-accent' : 'well bg-border',
        className,
      )}
    >
      <span
        className={cn(
          // бегунок пружинит, а пока кнопку держат - вытягивается в сторону хода
          'h-5 w-5 rounded-full bg-white bg-linear-to-b from-white to-[#e9edf2] shadow-[0_1px_3px_rgb(0_0_0/0.35)] transition-[translate,width] duration-300 ease-spring group-enabled:group-active:w-6',
          checked && 'translate-x-5 group-enabled:group-active:translate-x-4',
        )}
      />
    </button>
  );
}
