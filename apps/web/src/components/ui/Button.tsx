'use client';

/**
 * Button — design-system §9.1
 * Variants: primary · secondary · ghost · danger.
 * Loading state: inline spinner + disabled.
 * Min height 52 (lg: 56) per design system counter-speed floor.
 */
import type { ButtonHTMLAttributes } from 'react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
  'aria-label'?: string;
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-sm font-medium text-label transition-all duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:opacity-45 disabled:cursor-not-allowed active:scale-[0.97]';

const VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-primary text-on-primary hover:bg-primary-press',
  secondary: 'border border-border text-text bg-transparent hover:bg-surface-3',
  ghost: 'text-text-muted bg-transparent hover:bg-surface-3',
  danger: 'bg-danger text-white hover:bg-[#DC2626]',
};

const SIZES: Record<NonNullable<ButtonProps['size']>, string> = {
  md: 'h-[52px] px-xl',
  lg: 'h-[56px] px-xl',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      aria-busy={loading}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${fullWidth ? 'w-full' : ''} ${className}`}
    >
      {loading && (
        <svg
          aria-hidden="true"
          className="w-4 h-4 animate-spin"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {children}
    </button>
  );
}
