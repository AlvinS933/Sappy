// The overlay widget window (loaded with #companion): just the character, on a transparent
// background. Its mood comes from the chat window via the main process.
import { useEffect, useState } from 'react'
import { Companion, type CompanionMood } from './Companion'

export default function CompanionWidget() {
  const [mood, setMood] = useState<CompanionMood>('idle')

  useEffect(() => {
    void window.companion.getMood().then(setMood)
    return window.companion.onMood(setMood)
  }, [])

  return <Companion mood={mood} style={{ width: '100vw', height: '100vh' }} />
}
