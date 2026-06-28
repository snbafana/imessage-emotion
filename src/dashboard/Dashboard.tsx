import { useState } from 'react'
import { Avatar } from '@base-ui/react/avatar'
import { Button } from '@base-ui/react/button'
import ChatPanel from './ChatPanel'
import EmotionTimeline from './EmotionTimeline'
import Inspector from './Inspector'
import Sidebar from './Sidebar'
import { PEOPLE, SELECTED_INDEX } from './data'
import { RecalcIcon } from './icons'
import './dashboard.css'

export default function Dashboard() {
  const [activeId, setActiveId] = useState('maya')
  const [selectedBlock, setSelectedBlock] = useState(SELECTED_INDEX)
  const person = PEOPLE.find((p) => p.id === activeId) ?? PEOPLE[0]

  return (
    <div className="dashboard">
      <Sidebar activeId={activeId} onSelect={setActiveId} />

      <div className="main">
        <header className="header-bar">
          <Avatar.Root className="avatar" style={{ background: person.avatar }}>
            <Avatar.Fallback>{person.initial}</Avatar.Fallback>
          </Avatar.Root>
          <div className="id">
            <span className="name">{person.name}</span>
            <span className="range">Jan 2022 — Jun 2026 · {person.meta.split(' ·')[0]}</span>
          </div>
          <Button className="recalc">
            <RecalcIcon />
            Recalculate
          </Button>
        </header>

        <div className="body">
          <EmotionTimeline selected={selectedBlock} onSelectBlock={setSelectedBlock} />
          <div className="lower-row">
            <Inspector />
            <ChatPanel />
          </div>
        </div>
      </div>
    </div>
  )
}
