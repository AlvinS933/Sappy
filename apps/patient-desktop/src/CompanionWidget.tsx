// The overlay widget window (loaded with #companion): the character plus a speech bubble showing
// the sentence it's saying, on a transparent background. Mood and caption come from the chat
// window via the main process.
import { useEffect, useState } from 'react'
import { Companion, type CompanionMood } from './Companion'
import './CompanionWidget.css'

export default function CompanionWidget() {
  const [mood, setMood] = useState<CompanionMood>('idle')
  const [caption, setCaption] = useState<string | null>(null)
  // Keep the last text while the bubble fades out, so it doesn't go blank mid-animation.
  const [shownText, setShownText] = useState('')

  useEffect(() => {
    void window.companion.getMood().then(setMood)
    const offMood = window.companion.onMood(setMood)
    const offCaption = window.companion.onCaption((text) => {
      setCaption(text)
      if (text) setShownText(text)
    })
    return () => {
      offMood()
      offCaption()
    }
  }, [])

  return (
    <div className="companion-widget">
      <div className={`speech-bubble${caption ? ' visible' : ''}`} aria-live="polite">
        {shownText}
      </div>
      <Companion mood={mood} style={{ position: 'absolute', left: 0, bottom: 0, width: 220, height: 260 }} />
    </div>
  )
}
