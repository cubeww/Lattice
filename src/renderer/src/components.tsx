import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
export function IconButton({
  icon: Icon,
  label,
  active,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button${active ? ' active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      {...props}
    >
      <Icon size={16} strokeWidth={1.65} />
    </button>
  );
}
export function Empty({ children, icon: Icon }: { children: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="panel-empty">
      {Icon && <Icon size={25} strokeWidth={1.25} />}
      <span>{children}</span>
    </div>
  );
}
export function Brand({ large = false }: { large?: boolean }) {
  return (
    <svg
      className={large ? 'brand large' : 'brand'}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path d="M16 3 28 10v13l-12 7L4 23V10L16 3Z" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="m4 10 12 7 12-7M16 17v13M16 3v14L4 23m12-6 12 6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
