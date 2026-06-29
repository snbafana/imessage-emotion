import { Avatar } from '@base-ui/react/avatar'
import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import type { ConversationView } from './data'
import { formatMessageCount } from './data'
import { SearchIcon, SettingsIcon } from './icons'

export default function Sidebar({
  activeId,
  conversations,
  loading,
  error,
  onSelect,
  searchQuery,
  onSearchChange,
  onOpenSettings,
}: {
  activeId: string | null
  conversations: ConversationView[]
  loading: boolean
  error: string | null
  onSelect: (id: string) => void
  searchQuery: string
  onSearchChange: (value: string) => void
  onOpenSettings?: () => void
}) {
  const searching = searchQuery.trim().length > 0
  const analyzed = conversations.filter((conversation) => conversation.latestRun != null)
  const pending = conversations.filter((conversation) => conversation.latestRun == null)

  const renderPerson = (conversation: ConversationView) => (
    <Button
      key={conversation.id}
      className={`person${conversation.id === activeId ? ' active' : ''}`}
      onClick={() => onSelect(conversation.id)}
    >
      <Avatar.Root className="avatar" style={{ background: conversation.avatar }}>
        <Avatar.Fallback>{conversation.initial}</Avatar.Fallback>
      </Avatar.Root>
      <div className="meta">
        <span className="name">{conversation.title}</span>
        <span className="submeta">{formatMessageCount(conversation.messageCount)} msgs</span>
      </div>
    </Button>
  )

  const renderGroup = (label: string, group: ConversationView[]) => {
    if (group.length === 0) return null
    return (
      <div className="people-group">
        <span className="label people-group-label">
          {label} · {group.length}
        </span>
        {group.map(renderPerson)}
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="eyebrow">Emotion · timeline</span>
        <span className="wordmark">Undercurrent</span>
      </div>

      <div className="search">
        <SearchIcon />
        <Input
          placeholder="Search people"
          aria-label="Search people"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <span className="label section-label">
        Conversations · {loading ? 'loading' : conversations.length}
      </span>

      {error && <div className="sidebar-note error">{error}</div>}
      {!loading && conversations.length === 0 && !error && (
        <div className="sidebar-note">
          {searching
            ? `No people match “${searchQuery.trim()}”.`
            : 'No conversations yet. Sync messages to populate the dashboard.'}
        </div>
      )}

      <div className="people">
        {renderGroup('Analyzed', analyzed)}
        {renderGroup('Run analysis', pending)}
      </div>

      {onOpenSettings && (
        <div className="sidebar-actions">
          <Button className="sidebar-action" onClick={onOpenSettings}>
            <SettingsIcon />
            Settings
          </Button>
        </div>
      )}
    </aside>
  )
}
