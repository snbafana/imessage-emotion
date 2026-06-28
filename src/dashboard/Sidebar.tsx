import { Avatar } from '@base-ui/react/avatar'
import { Input } from '@base-ui/react/input'
import type { ConversationView } from './data'
import { formatMessageCount, runStateLabel } from './data'
import { SearchIcon } from './icons'

export default function Sidebar({
  activeId,
  conversations,
  loading,
  error,
  onSelect,
}: {
  activeId: string | null
  conversations: ConversationView[]
  loading: boolean
  error: string | null
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

      <span className="label section-label">
        Conversations · {loading ? 'loading' : conversations.length}
      </span>

      {error && <div className="sidebar-note error">{error}</div>}
      {!loading && conversations.length === 0 && !error && (
        <div className="sidebar-note">No analyzed conversations yet — recompute one to see it here.</div>
      )}

      <div className="people">
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            className={`person${conversation.id === activeId ? ' active' : ''}`}
            onClick={() => onSelect(conversation.id)}
          >
            <Avatar.Root className="avatar" style={{ background: conversation.avatar }}>
              <Avatar.Fallback>{conversation.initial}</Avatar.Fallback>
            </Avatar.Root>
            <div className="meta">
              <span className="name">{conversation.title}</span>
              <span className="submeta">
                {formatMessageCount(conversation.messageCount)} msgs ·{' '}
                {runStateLabel(conversation.latestRun, [])}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}
