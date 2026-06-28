// Inline stroke icons used across the dashboard mock.
type P = { size?: number; color?: string }

export const SearchIcon = ({ size = 14, color = '#6b6b70' }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

export const RecalcIcon = ({ size = 14, color = '#fff' }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2}>
    <path d="M21 2v6h-6" />
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
    <path d="M3 22v-6h6" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
  </svg>
)

export const SparkleIcon = ({ size = 15, color = '#0a0a0b' }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2}>
    <path d="M12 3l1.9 4.8L18.7 9.7 13.9 11.6 12 16.4 10.1 11.6 5.3 9.7 10.1 7.8 12 3Z" />
  </svg>
)

export const BulbIcon = ({ size = 13, color = '#1f44ff' }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2}>
    <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z" />
    <line x1="9" y1="21" x2="15" y2="21" />
  </svg>
)

export const ChevronIcon = ({ size = 13, color = '#9a9aa0' }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2}>
    <path d="M9 18l6-6-6-6" />
  </svg>
)

export const SendIcon = ({ size = 17, color = '#fff' }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2}>
    <line x1="12" y1="19" x2="12" y2="5" />
    <path d="M5 12l7-7 7 7" />
  </svg>
)
