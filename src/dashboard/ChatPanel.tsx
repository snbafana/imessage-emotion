import { Button } from '@base-ui/react/button'
import { Input } from '@base-ui/react/input'
import { CHAT } from './data'
import { ChevronIcon, SendIcon, SparkleIcon } from './icons'

export default function ChatPanel() {
  return (
    <section className="panel chat-panel">
      <div className="chat-head">
        <SparkleIcon />
        <span className="t">Ask the timeline</span>
        <span className="meta">Maya · 3 yrs</span>
      </div>

      <div className="chat-body">
        {CHAT.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="turn user">
              <div className="bubble">{turn.text}</div>
            </div>
          ) : (
            <div key={i} className="turn agent">
              <div className="text">{turn.text}</div>
              {turn.citation && (
                <button className="citation">
                  <span className="dot" style={{ background: turn.citation.color }} />
                  <span className="c-label">{turn.citation.label}</span>
                  <span className="c-delta" style={{ color: turn.citation.color }}>
                    {turn.citation.delta}
                  </span>
                  <ChevronIcon />
                </button>
              )}
            </div>
          ),
        )}
      </div>

      <div className="input-bar">
        <div className="field">
          <Input placeholder="Ask why, or recompute a window…" aria-label="Ask the timeline" />
        </div>
        <Button className="send" aria-label="Send">
          <SendIcon />
        </Button>
      </div>
    </section>
  )
}
