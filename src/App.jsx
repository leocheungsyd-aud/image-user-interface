import { useState, useEffect } from 'react'
import { getCurrentSession, signOut, parseUserFromSession } from './auth/cognito'
import Login from './components/Login'
import Sidebar from './components/Sidebar'
import FileUpload from './components/FileUpload'
import './App.css'

export default function App() {
  const [session, setSession] = useState(undefined) // undefined = checking
  const [selectedBucket, setSelectedBucket] = useState(null)

  useEffect(() => {
    getCurrentSession().then(setSession).catch(() => setSession(null))
  }, [])

  // Still checking stored session
  if (session === undefined) return null

  if (!session) {
    return <Login onLogin={setSession} />
  }

  const payload = parseUserFromSession(session)
  const userLabel = payload?.email || payload?.['cognito:username'] || 'User'

  const handleSignOut = () => {
    signOut()
    setSession(null)
  }

  return (
    <main className="app">
      <div className="card">
        <div className="card-header">
          <div className="logo">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <div className="header-title">
            <h1>ZIP Uploader</h1>
            <p className="subtitle">
              {selectedBucket ? (
                <>Uploading to <strong>{selectedBucket}</strong></>
              ) : (
                'Select a bucket to get started'
              )}
            </p>
          </div>
          <div className="header-user">
            <span className="user-label">{userLabel}</span>
            <button className="signout-btn" onClick={handleSignOut}>Sign out</button>
          </div>
        </div>

        <div className="card-body">
          <Sidebar selectedBucket={selectedBucket} onSelect={setSelectedBucket} />
          <div className="main-panel">
            {selectedBucket ? (
              <FileUpload key={selectedBucket} bucket={selectedBucket} />
            ) : (
              <div className="panel-placeholder">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M9 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                <p>Select a bucket from the sidebar</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
