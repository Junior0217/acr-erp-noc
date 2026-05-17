# Cult UI / shadcn-style components

Carpeta destino para componentes de Cult UI (cult-ui.com) y patrones shadcn-style.

## Convención

- Cada componente vive como `<Nombre>.jsx` en esta carpeta.
- Usa `cn()` de `@shared/utils/cn` para clases (`clsx + tailwind-merge`).
- Animaciones via `framer-motion` (ya instalado).
- Iconos via `lucide-react` (ya en proyecto).
- Estilos siguen la paleta corporativa: `bg-slate-900` / `text-slate-100` / `blue-600` (ver CLAUDE.md).

## Cómo agregar un componente Cult UI

1. Visita https://www.cult-ui.com/docs/components/<componente>
2. Copia el JSX de la versión vanilla (sin TS).
3. Pega como `frontend/src/shared/components/ui/<Componente>.jsx`.
4. Sustituye imports:
   - `import { cn } from "@/lib/utils"` → `import { cn } from '@shared/utils/cn'`
   - Cualquier `cva` → `import { cva } from 'class-variance-authority'`
5. Re-mapea colores al sistema NOC (slate-900 / slate-100 / blue-600) si hace falta.
6. Importa desde features con `@shared/components/ui/<Componente>`.

## Deps de runtime (ya instaladas)

- `framer-motion`
- `clsx`
- `tailwind-merge`
- `class-variance-authority`
- `lucide-react`
- `tailwindcss` 3.4

## Componentes priorizados (sugerencia inicial)

- `Button` — variantes primary/secondary/ghost/danger.
- `Dialog` — modal con backdrop + focus trap.
- `Tooltip` — anclaje con framer-motion.
- `Sheet` — slide-over derecha (alternativa a `CarritoSlideOver` actual).
- `Tabs` — navegación segmentada interna.
- `Toast` — ya usamos `sonner`; mantener.

Cada uno se copia bajo demanda, NO precargar la librería completa.
