import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

export function Button({ children, className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; variant?: 'primary' | 'secondary' }): ReactElement {
  return <button className={`kb-button ${variant === 'secondary' ? 'secondary' : ''} ${className}`.trim()} type="button" {...props}>{children}</button>;
}
