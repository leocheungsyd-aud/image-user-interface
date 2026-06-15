import { useState, useEffect, useCallback, useRef } from 'react'
import './Sidebar.css'

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function lastName(path) {
  const trimmed = path.replace(/\/$/, '')
  const i = trimmed.lastIndexOf('/')
  return i === -1 ? trimmed : trimmed.slice(i + 1)
}

function nk(bucket, prefix) {
  return `${bucket}\x00${prefix}`
}

// ── Icons ────────────────────────────────────────────────────────────────────

function ChevronIcon({ open }) {
  return (
    <svg
      className={`tree-chevron${open ? ' tree-chevron--open' : ''}`}
      width="12" height="12" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

function BucketIcon() {
  return (
    <svg className="tree-icon tree-icon--bucket" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </svg>
  )
}

function FolderIcon({ open }) {
  return open ? (
    <svg className="tree-icon tree-icon--folder" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  ) : (
    <svg className="tree-icon tree-icon--folder" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="tree-icon tree-icon--file" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  )
}

function RefreshIcon({ spinning }) {
  return (
    <svg
      className={`refresh-icon${spinning ? ' refresh-icon--spinning' : ''}`}
      width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5"
    >
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  )
}

function Spinner() {
  return <span className="tree-spinner" />
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Sidebar({ selectedBucket, onSelect }) {
  const [buckets, setBuckets] = useState([])
  const [bucketsLoading, setBucketsLoading] = useState(true)
  const [bucketsError, setBucketsError] = useState(null)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState(new Set())
  const [nodeData, setNodeData] = useState({})
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  // ── Data fetching ──────────────────────────────────────────────────────────

  const loadBuckets = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setBucketsLoading(true)
    setBucketsError(null)

    try {
      const r = await fetch('/api/buckets')
      if (!r.ok) throw new Error(`Server error: ${r.status}`)
      const { buckets } = await r.json()
      setBuckets(buckets)
      if (buckets.length > 0 && !selectedBucket) onSelect(buckets[0].name)
    } catch (e) {
      setBucketsError(e.message)
    } finally {
      setBucketsLoading(false)
      if (isRefresh) setRefreshing(false)
    }
  }, [selectedBucket, onSelect])

  const loadNode = useCallback(async (bucket, prefix) => {
    const key = nk(bucket, prefix)
    setNodeData((prev) => ({ ...prev, [key]: { loading: true } }))
    try {
      const r = await fetch(
        `/api/objects?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`,
      )
      if (!r.ok) throw new Error(`Server error: ${r.status}`)
      const data = await r.json()
      setNodeData((prev) => ({ ...prev, [key]: data }))
    } catch (e) {
      setNodeData((prev) => ({ ...prev, [key]: { error: e.message } }))
    }
  }, [])

  useEffect(() => { loadBuckets() }, [])

  // ── Refresh ────────────────────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    if (refreshing) return
    setNodeData({})
    await loadBuckets(true)
    // re-fetch all currently open nodes
    const openKeys = [...expandedRef.current]
    await Promise.all(
      openKeys.map((key) => {
        const [bucket, prefix] = key.split('\x00')
        return loadNode(bucket, prefix)
      }),
    )
  }, [refreshing, loadBuckets, loadNode])

  // ── Toggle expand/collapse ─────────────────────────────────────────────────

  const toggle = useCallback((bucket, prefix) => {
    const key = nk(bucket, prefix)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        loadNode(bucket, prefix)
      }
      return next
    })
  }, [loadNode])

  // ── Renderers ──────────────────────────────────────────────────────────────

  function renderChildren(bucket, prefix, depth) {
    const key = nk(bucket, prefix)
    const data = nodeData[key]

    if (!data || data.loading) {
      return (
        <div className="tree-feedback" style={{ paddingLeft: `${depth * 14 + 22}px` }}>
          <Spinner /> Loading…
        </div>
      )
    }
    if (data.error) {
      return (
        <div className="tree-feedback tree-feedback--error" style={{ paddingLeft: `${depth * 14 + 22}px` }}>
          {data.error}
        </div>
      )
    }

    const { prefixes = [], objects = [] } = data
    if (prefixes.length === 0 && objects.length === 0) {
      return (
        <div className="tree-feedback tree-feedback--empty" style={{ paddingLeft: `${depth * 14 + 22}px` }}>
          Empty
        </div>
      )
    }

    return (
      <>
        {prefixes.map((p) => {
          const open = expanded.has(nk(bucket, p))
          return (
            <div key={p}>
              <button
                className={`tree-row${open ? ' tree-row--open' : ''}`}
                style={{ paddingLeft: `${depth * 14 + 8}px` }}
                onClick={() => toggle(bucket, p)}
                title={p}
              >
                <ChevronIcon open={open} />
                <FolderIcon open={open} />
                <span className="tree-label">{lastName(p)}</span>
              </button>
              {open && renderChildren(bucket, p, depth + 1)}
            </div>
          )
        })}
        {objects.map((o) => (
          <div
            key={o.key}
            className="tree-row tree-row--file"
            style={{ paddingLeft: `${depth * 14 + 22}px` }}
            title={o.key}
          >
            <FileIcon />
            <span className="tree-label">{lastName(o.key)}</span>
            <span className="tree-size">{formatBytes(o.size)}</span>
          </div>
        ))}
      </>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">S3 Buckets</span>
        <div className="sidebar-header-actions">
          {!bucketsLoading && !bucketsError && (
            <span className="sidebar-count">{buckets.length}</span>
          )}
          <button
            className="refresh-btn"
            onClick={refresh}
            disabled={refreshing}
            title="Refresh file list"
          >
            <RefreshIcon spinning={refreshing} />
          </button>
        </div>
      </div>

      <div className="sidebar-body">
        {bucketsLoading && (
          <ul className="sidebar-skeletons">
            {Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="sidebar-skeleton" />
            ))}
          </ul>
        )}

        {bucketsError && (
          <div className="tree-feedback tree-feedback--error" style={{ padding: '12px 14px' }}>
            {bucketsError}
          </div>
        )}

        {!bucketsLoading && !bucketsError && (
          <div className="tree">
            {buckets.map((b) => {
              const open = expanded.has(nk(b.name, ''))
              const isSelected = selectedBucket === b.name
              return (
                <div key={b.name}>
                  <button
                    className={`tree-row tree-row--bucket${isSelected ? ' tree-row--selected' : ''}`}
                    onClick={() => { onSelect(b.name); toggle(b.name, '') }}
                    title={b.name}
                  >
                    <ChevronIcon open={open} />
                    <BucketIcon />
                    <span className="tree-label">{b.name}</span>
                  </button>
                  {open && renderChildren(b.name, '', 1)}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </nav>
  )
}
