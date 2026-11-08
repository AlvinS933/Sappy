// Small inline icons (stroke style), sized by font-size.
import type { SVGProps } from 'react'

const base = {
  width: '1.15em', height: '1.15em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
}

export const BellIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
)
export const UsersIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
)
export const HistoryIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>
)
export const PulseIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
)
