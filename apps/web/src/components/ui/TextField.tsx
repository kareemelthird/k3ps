'use client';

/**
 * TextField — design-system §9.6
 * Visible label (never placeholder-only). Error below the field.
 * Validate on blur, not keystroke.
 */
import { forwardRef, useState, type InputHTMLAttributes } from 'react';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  error?: string;
  helper?: string;
  required?: boolean;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField({ label, error, helper, required, type, id, ...props }, ref) {
    const fieldId = id ?? `field-${label.replace(/\s+/g, '-').toLowerCase()}`;
    const [showPassword, setShowPassword] = useState(false);
    const isPassword = type === 'password';
    const inputType = isPassword ? (showPassword ? 'text' : 'password') : type;

    return (
      <div className="flex flex-col gap-xs">
        <label
          htmlFor={fieldId}
          className="text-label font-medium text-text-muted text-start"
        >
          {label}
          {required && (
            <span className="text-danger ms-1" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <div className="relative">
          <input
            {...props}
            ref={ref}
            id={fieldId}
            type={inputType}
            required={required}
            aria-describedby={
              error
                ? `${fieldId}-error`
                : helper
                  ? `${fieldId}-helper`
                  : undefined
            }
            aria-invalid={error ? 'true' : undefined}
            className={`w-full h-[52px] px-md rounded-sm text-body text-text bg-surface-3 border transition-colors duration-fast
              focus:outline-none focus:ring-2 focus:ring-primary focus:border-border-strong
              disabled:opacity-45 disabled:cursor-not-allowed
              ${error ? 'border-danger' : 'border-border'}
              ${isPassword ? 'pe-12' : ''}`}
          />
          {isPassword && (
            <button
              type="button"
              aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 end-0 flex items-center px-md text-text-muted hover:text-text transition-colors"
              tabIndex={-1}
            >
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                {showPassword ? (
                  <>
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                ) : (
                  <>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                )}
              </svg>
            </button>
          )}
        </div>
        {error && (
          <p
            id={`${fieldId}-error`}
            role="alert"
            aria-live="polite"
            className="text-caption text-danger text-start"
          >
            {error}
          </p>
        )}
        {!error && helper && (
          <p id={`${fieldId}-helper`} className="text-caption text-text-faint text-start">
            {helper}
          </p>
        )}
      </div>
    );
  },
);
