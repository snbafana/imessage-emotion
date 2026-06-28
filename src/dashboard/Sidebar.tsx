import { Avatar } from '@base-ui/react/avatar'
import { Input } from '@base-ui/react/input'
import { EMOTIONS, PEOPLE, type Person } from './data'
import { SearchIcon } from './icons'

function Sparkline({ trend }: { trend: Person['trend'] }) {
  return (
    <div className="spark">
      {trend.map((b, i) => (
        <span
          key={i}
          style={{ height: `${6 + b.intensity * 16}px`, background: EMOTIONS[b.emotion].color }}
        />
      ))}
    </div>
  )
}

export default function Sidebar({
  activeId,
  onSelect,
}: {
  activeId: string
  onSelect: (id: string) => void
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="eyebrow">Emotion · timeline</span>
        <span className="wordmark">Undercurrent</span>
      </div>

      <div className="search">
        <SearchIcon />
        <Input placeholder="Search people" aria-label="Search people" />
      </div>

      <span className="label section-label">People · {PEOPLE.length}</span>

      <div className="people">
        {PEOPLE.map((p) => (
          <button
            key={p.id}
            className={`person${p.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <Avatar.Root className="avatar" style={{ background: p.avatar }}>
              <Avatar.Fallback>{p.initial}</Avatar.Fallback>
            </Avatar.Root>
            <div className="meta">
              <span className="name">{p.name}</span>
              <span className="submeta">{p.meta}</span>
            </div>
            <Sparkline trend={p.trend} />
          </button>
        ))}
      </div>
    </aside>
  )
}
