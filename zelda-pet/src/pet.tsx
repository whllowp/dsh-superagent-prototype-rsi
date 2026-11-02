/** The forest companion: an original leaf-mask sprite in the Korok spirit, wandering the bottom edge of the app. */
import { useEffect, useRef, useState } from 'react'

type Size = 'small' | 'middle' | 'large'
interface Settings { size: Size; lines: boolean }
const STORE_KEY = 'zelda-pet-settings'
const SIZES: Record<Size, number> = { small: 64, middle: 88, large: 120 }
const LINES = [
  '呀哈！你找到我啦！', '今天也要一起加油哦', '嘿嘿，我在看你写代码', '累了的话，摸摸我休息一下',
  '种子……我藏了一颗种子', '呼啊——风好舒服', '遇到了虫虫？交给我！', ' mister! ……啊不对，你好呀',
]
const NIGHT_LINES = ['呼……呼……（睡着了）', 'zzz……梦里都是种子']

const isNight = (): boolean => { const hour = new Date().getHours(); return hour >= 22 || hour < 6 }

/** Loads the saved settings once; a missing or broken save reads as the friendly defaults. */
function loadSettings(): Settings {
  try { const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '') as Settings
    if (saved && SIZES[saved.size]) return { size: saved.size, lines: saved.lines !== false } } catch { /* first visit */ }
  return { size: 'middle', lines: true }
}

export function PetStage(): JSX.Element {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [x, setX] = useState<number>(() => Math.round(window.innerWidth * 0.7))
  const [facing, setFacing] = useState<1 | -1>(-1)
  const [mood, setMood] = useState<'idle' | 'jump' | 'dance' | 'sleep'>('idle')
  const [bubble, setBubble] = useState<string>('')
  const [gearOpen, setGearOpen] = useState(false)
  const bubbleTimer = useRef<number>(undefined)

  const sleeping = mood === 'sleep' || (mood === 'idle' && isNight())

  useEffect(() => { localStorage.setItem(STORE_KEY, JSON.stringify(settings)) }, [settings])

  // The wander: every few seconds pick a nearby spot and stroll there, pausing while asleep or dancing.
  useEffect(() => {
    if (sleeping) return
    const timer = window.setInterval(() => {
      setMood(current => current === 'dance' ? current : 'idle')
      setX(current => {
        const span = window.innerWidth - SIZES[settings.size] - 60
        const target = Math.max(30, Math.min(span, current + (Math.random() * 2 - 1) * 220))
        setFacing(target >= current ? 1 : -1)
        return target
      })
    }, 4200 + Math.random() * 2600)
    return () => window.clearInterval(timer)
  }, [settings.size, sleeping])

  const say = (text: string): void => {
    if (!settings.lines) return
    setBubble(text)
    window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(''), 2800)
  }
  const wake = (): void => { setMood('idle'); say(NIGHT_LINES[0]!.replace('呼……呼……（睡着了）', '唔……我醒啦')) }

  const onClick = (): void => {
    if (sleeping) { wake(); return }
    setMood('jump')
    say(LINES[Math.floor(Math.random() * LINES.length)]!)
    window.setTimeout(() => setMood('idle'), 700)
  }
  const onDoubleClick = (): void => {
    if (sleeping) { wake(); return }
    setMood('dance')
    say('啦啦啦——♪')
    window.setTimeout(() => setMood('idle'), 1800)
  }

  const size = SIZES[settings.size]
  return <div className="zpet-stage">
    <style>{CSS}</style>
    <div className="zpet-pet-anchor" style={{ left: x, width: size }}>
      {bubble ? <div className="zpet-bubble">{bubble}</div> : sleeping ? <div className="zpet-bubble zpet-zzz">z<span>z</span><i>z</i></div> : null}
      <div className={['zpet-body', `zpet-${mood}`, sleeping ? 'zpet-night' : '', facing < 0 ? 'zpet-flip' : ''].join(' ')}
        onClick={onClick} onDoubleClick={onDoubleClick} role="button" aria-label="森林伙伴">
        <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
          {/* leaf hood */}
          <path className="zpet-leaf" d="M32 6 C 20 10, 14 20, 16 30 L 48 30 C 50 20, 44 10, 32 6 Z" fill="#5da95a" />
          <path className="zpet-leaf" d="M32 6 C 36 12, 38 18, 37 24" stroke="#3f8a3d" strokeWidth="2" fill="none" strokeLinecap="round" />
          <path className="zpet-stem" d="M32 6 C 32 3, 33 2, 35 1" stroke="#8a5a2b" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          {/* face */}
          <ellipse cx="32" cy="40" rx="17" ry="16" fill="#f3e9c8" />
          <ellipse cx="32" cy="40" rx="17" ry="16" fill="none" stroke="#caa96a" strokeWidth="1.6" />
          <g className="zpet-eyes">
            <ellipse cx="25" cy="38" rx="3.4" ry="4.6" fill="#3a2e20" />
            <ellipse cx="39" cy="38" rx="3.4" ry="4.6" fill="#3a2e20" />
            <circle cx="26.2" cy="36.4" r="1.1" fill="#fff" />
            <circle cx="40.2" cy="36.4" r="1.1" fill="#fff" />
          </g>
          <path className="zpet-mouth" d="M28 46 Q 32 49 36 46" stroke="#b98a4e" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          {/* blush + feet */}
          <circle className="zpet-blush" cx="20" cy="44" r="2.6" fill="#f0b8a0" opacity="0.7" />
          <circle className="zpet-blush" cx="44" cy="44" r="2.6" fill="#f0b8a0" opacity="0.7" />
          <ellipse cx="26" cy="56" rx="5" ry="3" fill="#5da95a" />
          <ellipse cx="38" cy="56" rx="5" ry="3" fill="#5da95a" />
        </svg>
      </div>
      <button className="zpet-gear" aria-label="伙伴设置" onClick={event => { event.stopPropagation(); setGearOpen(open => !open) }}>⚙</button>
      {gearOpen ? <div className="zpet-gear-panel" onClick={event => event.stopPropagation()}>
        <div className="zpet-gear-row">
          <span>体型</span>
          {(['small', 'middle', 'large'] as const).map(candidate => <button key={candidate}
            className={candidate === settings.size ? 'zpet-on' : ''}
            onClick={() => setSettings(previous => ({ ...previous, size: candidate }))}>
            {candidate === 'small' ? '小' : candidate === 'middle' ? '中' : '大'}
          </button>)}
        </div>
        <label className="zpet-gear-row">
          <input type="checkbox" checked={settings.lines} onChange={event => setSettings(previous => ({ ...previous, lines: event.target.checked }))} />
          <span>说话</span>
        </label>
        <div className="zpet-gear-tip">单击 = 打招呼 · 双击 = 跳舞 · 晚上会打瞌睡</div>
      </div> : null}
    </div>
  </div>
}

const CSS = `
.zpet-stage { position: fixed; inset: 0; pointer-events: none; z-index: 9999; font-family: inherit; }
.zpet-pet-anchor { position: absolute; bottom: 26px; transition: left 2.8s ease-in-out; pointer-events: none; }
.zpet-body { position: relative; cursor: pointer; pointer-events: auto; animation: zpet-bob 2.6s ease-in-out infinite;
  transform-origin: 50% 100%; filter: drop-shadow(0 3px 4px rgba(0,0,0,.18)); }
.zpet-flip svg { transform: scaleX(-1); }
.zpet-jump { animation: zpet-jump .7s ease; }
.zpet-dance { animation: zpet-dance 1.8s ease-in-out; }
.zpet-night .zpet-eyes ellipse { transform: scaleY(.12); transform-origin: center; }
.zpet-eyes ellipse { transition: transform .3s; animation: zpet-blink 5.2s infinite; transform-origin: center; }
.zpet-leaf, .zpet-stem { animation: zpet-sway 3.4s ease-in-out infinite; transform-origin: 32px 8px; }
@keyframes zpet-bob { 0%,100% { translate: 0 0 } 50% { translate: 0 -4px } }
@keyframes zpet-jump { 0% { translate: 0 0 } 35% { translate: 0 -34px } 62% { translate: 0 0 } 78% { translate: 0 -10px } 100% { translate: 0 0 } }
@keyframes zpet-dance { 0%,100% { rotate: 0deg } 25% { rotate: -14deg; translate: 0 -8px } 50% { rotate: 14deg } 75% { rotate: -10deg; translate: 0 -6px } }
@keyframes zpet-blink { 0%,94%,100% { transform: scaleY(1) } 97% { transform: scaleY(.12) } }
@keyframes zpet-sway { 0%,100% { rotate: -3deg } 50% { rotate: 4deg } }
.zpet-bubble { position: absolute; bottom: calc(100% + 8px); left: 50%; translate: -50% 0; background: #fffdf4;
  color: #4a3b28; border: 1.5px solid #d8c79a; border-radius: 12px; padding: 6px 10px; font-size: 12px; white-space: nowrap;
  pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,.12); animation: zpet-pop .25s ease; }
.zpet-bubble::after { content: ''; position: absolute; top: 100%; left: 50%; translate: -50% 0;
  border: 5px solid transparent; border-top-color: #fffdf4; }
@keyframes zpet-pop { from { scale: .6; opacity: 0 } to { scale: 1; opacity: 1 } }
.zpet-zzz { letter-spacing: 2px; color: #7f95b8; border-color: #c4d2e8; background: #f2f7ff; }
.zpet-zzz span, .zpet-zzz i { font-style: normal; opacity: .6 }
.zpet-gear { position: absolute; top: -6px; right: -10px; border: none; background: #fffdf4; border-radius: 999px;
  width: 22px; height: 22px; font-size: 12px; color: #8a7749; cursor: pointer; pointer-events: auto; opacity: 0;
  transition: opacity .2s; box-shadow: 0 1px 4px rgba(0,0,0,.15); }
.zpet-pet-anchor:hover .zpet-gear { opacity: 1 }
.zpet-gear-panel { position: absolute; bottom: calc(100% + 10px); right: 0; background: #fffdf4; border: 1.5px solid #d8c79a;
  border-radius: 12px; padding: 10px 12px; pointer-events: auto; color: #4a3b28; font-size: 12px; min-width: 150px;
  box-shadow: 0 4px 14px rgba(0,0,0,.16); animation: zpet-pop .2s ease; }
.zpet-gear-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.zpet-gear-row button { border: 1px solid #d8c79a; background: none; border-radius: 6px; padding: 1px 8px; cursor: pointer; color: inherit; }
.zpet-gear-row button.zpet-on { background: #5da95a; border-color: #5da95a; color: #fff; }
.zpet-gear-tip { color: #8a7749; font-size: 11px; margin-top: 4px }
@media (prefers-reduced-motion: reduce) { .zpet-body, .zpet-leaf, .zpet-stem, .zpet-eyes ellipse { animation: none } }
`
