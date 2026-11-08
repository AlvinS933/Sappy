// The companion character as a desktop overlay: a small frameless, transparent, always-on-top
// window in the bottom-left corner of the screen. It ignores the mouse (clicks pass through to
// whatever is underneath) and never takes focus.
//
// The chat window tells it what the assistant is doing ("mood"), and it plays the matching animation.
import { BrowserWindow, ipcMain, screen } from 'electron'

const WIDTH = 220
const HEIGHT = 260
const MARGIN = 12 // gap from the screen edges

const MOODS = ['idle', 'listening', 'thinking', 'speaking'] as const
type Mood = (typeof MOODS)[number]

let widget: BrowserWindow | null = null
let mood: Mood = 'idle'

/** Bottom-left corner of the primary display, above the Dock/taskbar. */
function position() {
  const { x, y, height } = screen.getPrimaryDisplay().workArea
  return { x: x + MARGIN, y: y + height - HEIGHT - MARGIN }
}

export function createCompanionWindow(opts: { preload: string; load: (win: BrowserWindow) => void }) {
  if (widget && !widget.isDestroyed()) return widget

  widget = new BrowserWindow({
    ...position(),
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: opts.preload,
      backgroundThrottling: false, // keep animating while other apps are in front
    },
  })

  widget.setAlwaysOnTop(true, 'floating')
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  widget.setIgnoreMouseEvents(true) // click-through
  widget.once('ready-to-show', () => widget?.showInactive()) // appear without stealing focus
  widget.on('closed', () => {
    widget = null
  })

  // Stay in the corner if the screen layout changes (resolution, Dock moved, monitor unplugged).
  const reposition = () => widget && !widget.isDestroyed() && widget.setBounds({ ...position(), width: WIDTH, height: HEIGHT })
  screen.on('display-metrics-changed', reposition)
  screen.on('display-removed', reposition)

  opts.load(widget)
  return widget
}

export function closeCompanionWindow() {
  if (widget && !widget.isDestroyed()) widget.close()
}

export function registerCompanionHandlers() {
  // From the chat window: what the assistant is doing now.
  ipcMain.on('companion:set-mood', (_event, value: unknown) => {
    if (!MOODS.includes(value as Mood)) return
    mood = value as Mood
    if (widget && !widget.isDestroyed()) widget.webContents.send('companion:mood', mood)
  })
  // From the widget on startup, in case the mood changed before it loaded.
  ipcMain.handle('companion:get-mood', () => mood)
}
