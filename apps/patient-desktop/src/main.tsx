import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import CompanionWidget from './CompanionWidget.tsx'
import './index.css'

// The same page is loaded in two windows: the chat window, and the companion overlay (#companion).
const isWidget = window.location.hash === '#companion'
if (isWidget) document.documentElement.classList.add('companion-widget')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isWidget ? <CompanionWidget /> : <App />}</React.StrictMode>,
)
