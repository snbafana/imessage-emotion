import { Button } from '@base-ui/react/button'
import { Progress } from '@base-ui/react/progress'
import { Switch } from '@base-ui/react/switch'
import { Tabs } from '@base-ui/react/tabs'
import './App.css'

const primitives = [
  'Tabs for switching analysis/chat/eval views',
  'Switch for grounded chat and recalculation options',
  'Progress for analysis and eval status',
  'Button for commands like recalculate',
]

function App() {
  return (
    <main className="app">
      <section className="surface">
        <div className="header">
          <div>
            <p className="eyebrow">Base UI installed</p>
            <h1>iMessage Emotion</h1>
          </div>
          <Button className="button">Recalculate</Button>
        </div>

        <Tabs.Root className="tabs-root" defaultValue="analysis">
          <Tabs.List className="tabs-list" aria-label="Relevant app primitives">
            <Tabs.Tab className="tab" value="analysis">
              Analysis
            </Tabs.Tab>
            <Tabs.Tab className="tab" value="chat">
              Chat
            </Tabs.Tab>
            <Tabs.Tab className="tab" value="evals">
              Evals
            </Tabs.Tab>
            <Tabs.Indicator className="tab-indicator" />
          </Tabs.List>

          <Tabs.Panel className="panel" value="analysis">
            <div className="row">
              <div>
                <h2>Relevant primitives</h2>
                <ul>
                  {primitives.map((primitive) => (
                    <li key={primitive}>{primitive}</li>
                  ))}
                </ul>
              </div>
              <label className="switch-row">
                <span>Grounded chat</span>
                <Switch.Root className="switch" defaultChecked aria-label="Grounded chat">
                  <Switch.Thumb className="switch-thumb" />
                </Switch.Root>
              </label>
            </div>

            <Progress.Root className="progress" value={68} aria-label="Setup progress">
              <Progress.Track className="progress-track">
                <Progress.Indicator className="progress-indicator" />
              </Progress.Track>
            </Progress.Root>
          </Tabs.Panel>

          <Tabs.Panel className="panel" value="chat">
            <h2>Chat surface placeholder</h2>
            <p>Base UI tabs are ready for the grounded chat view.</p>
          </Tabs.Panel>

          <Tabs.Panel className="panel" value="evals">
            <h2>Eval surface placeholder</h2>
            <p>Base UI progress and command controls are ready for eval status.</p>
          </Tabs.Panel>
        </Tabs.Root>
      </section>
    </main>
  )
}

export default App
