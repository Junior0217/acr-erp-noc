/**
 * cn() — class concat helper compatible con Cult UI / shadcn / Tailwind.
 * Combina clsx (condicionales + arrays) con tailwind-merge (dedup de utilidades
 * Tailwind para que la última gane: `cn("px-2","px-4") === "px-4"`).
 *
 * Uso:
 *   import { cn } from '@shared/utils/cn';
 *   <div className={cn("p-4", isActive && "bg-blue-600", className)} />
 */
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
