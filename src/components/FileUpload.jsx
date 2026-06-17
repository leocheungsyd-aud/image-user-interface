import { useState, useRef, useCallback } from 'react'
import { authedFetch } from '../auth/authedFetch'
import './FileUpload.css'

const MAX_SIZE_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB
const CHUNK_SIZE = 50 * 1024 * 1024 // 50 MB per part
const MULTIPART_THRESHOLD = 100 * 1024 * 1024 // use multipart for files > 100 MB
const UPLOAD_CONCURRENCY = 3

const STATES = {
  IDLE: 'idle',
  DRAGGING: 'dragging',
  UPLOADING: 'uploading',
  SUCCESS: 'success',
  ERROR: 'error',
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

async function apiPost(path, body) {
  const res = await authedFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}))
    throw new Error(error || `Server error: ${res.status}`)
  }
  return res.json()
}

async function fetchPresignedUrl(filename, contentType, bucket) {
  return apiPost('/api/presign', { filename, contentType, bucket }) // { url, key }
}

function uploadPartXhr(url, chunk, onChunkProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onChunkProgress(e.loaded)
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag'))
      else reject(new Error(`Part upload failed: ${xhr.status}`))
    })
    xhr.addEventListener('error', () => reject(new Error('Network error during part upload')))
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')))
    xhr.send(chunk)
  })
}

async function uploadMultipart(file, bucket, onProgress) {
  const totalParts = Math.ceil(file.size / CHUNK_SIZE)
  const partNumbers = Array.from({ length: totalParts }, (_, i) => i + 1)

  const { uploadId, key } = await apiPost('/api/multipart/create', {
    filename: file.name,
    contentType: file.type || 'application/zip',
    bucket,
  })

  try {
    const { parts } = await apiPost('/api/multipart/presign-parts', { key, bucket, uploadId, partNumbers })

    const uploadedBytes = new Array(totalParts).fill(0)
    const completedParts = new Array(totalParts)
    const queue = [...parts]

    async function drainQueue() {
      while (queue.length > 0) {
        const { partNumber, url } = queue.shift()
        const start = (partNumber - 1) * CHUNK_SIZE
        const chunk = file.slice(start, Math.min(start + CHUNK_SIZE, file.size))
        const etag = await uploadPartXhr(url, chunk, (loaded) => {
          uploadedBytes[partNumber - 1] = loaded
          onProgress(Math.round(uploadedBytes.reduce((a, b) => a + b, 0) / file.size * 100))
        })
        completedParts[partNumber - 1] = { partNumber, etag }
      }
    }

    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, drainQueue))

    await apiPost('/api/multipart/complete', { key, bucket, uploadId, parts: completedParts })
    return key
  } catch (err) {
    apiPost('/api/multipart/abort', { key, bucket, uploadId }).catch(() => {})
    throw err
  }
}

function uploadToS3(presignedUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', presignedUrl)
    xhr.setRequestHeader('Content-Type', file.type || 'application/zip')

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`S3 upload failed: ${xhr.status}`))
    })

    xhr.addEventListener('error', () => reject(new Error(`Network error during upload (status: ${xhr.status}, readyState: ${xhr.readyState})`)))
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')))

    xhr.send(file)
  })
}

export default function FileUpload({ bucket }) {
  const [status, setStatus] = useState(STATES.IDLE)
  const [file, setFile] = useState(null)
  const [progress, setProgress] = useState(0)
  const [s3Key, setS3Key] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const inputRef = useRef(null)

  const validateFile = (f) => {
    if (!f.name.toLowerCase().endsWith('.zip') && f.type !== 'application/zip') {
      return 'Only ZIP files (.zip) are accepted.'
    }
    if (f.size > MAX_SIZE_BYTES) {
      return `File exceeds the 5 GB limit (${formatBytes(f.size)}).`
    }
    return null
  }

  const startUpload = useCallback(async (f) => {
    const err = validateFile(f)
    if (err) {
      setErrorMessage(err)
      setStatus(STATES.ERROR)
      return
    }

    setFile(f)
    setProgress(0)
    setS3Key(null)
    setErrorMessage('')
    setStatus(STATES.UPLOADING)

    try {
      let key
      if (f.size > MULTIPART_THRESHOLD) {
        key = await uploadMultipart(f, bucket, setProgress)
      } else {
        const { url, key: singleKey } = await fetchPresignedUrl(f.name, f.type || 'application/zip', bucket)
        await uploadToS3(url, f, setProgress)
        key = singleKey
      }
      setS3Key(key)
      setStatus(STATES.SUCCESS)
    } catch (e) {
      setErrorMessage(e.message)
      setStatus(STATES.ERROR)
    }
  }, [bucket])

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault()
      setStatus(STATES.IDLE)
      const dropped = e.dataTransfer.files[0]
      if (dropped) startUpload(dropped)
    },
    [startUpload],
  )

  const handleDragOver = (e) => {
    e.preventDefault()
    setStatus(STATES.DRAGGING)
  }

  const handleDragLeave = () => setStatus(STATES.IDLE)

  const handleFileChange = (e) => {
    const selected = e.target.files[0]
    if (selected) startUpload(selected)
    e.target.value = ''
  }

  const reset = () => {
    setStatus(STATES.IDLE)
    setFile(null)
    setProgress(0)
    setS3Key(null)
    setErrorMessage('')
  }

  if (status === STATES.SUCCESS) {
    return (
      <div className="fu-body">
        <div className="fu-result fu-result--success">
          <div className="fu-result-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </div>
          <h2>Upload complete</h2>
          <p className="fu-filename">{file?.name}</p>
          <p className="fu-size">{formatBytes(file?.size ?? 0)}</p>
          <div className="fu-key-box">
            <span className="fu-key-label">S3 key</span>
            <code className="fu-key">{s3Key}</code>
          </div>
          <button className="btn btn--secondary" onClick={reset}>
            Upload another file
          </button>
        </div>
      </div>
    )
  }

  if (status === STATES.ERROR) {
    return (
      <div className="fu-body">
        <div className="fu-result fu-result--error">
          <div className="fu-result-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2>Upload failed</h2>
          <p className="fu-error-msg">{errorMessage}</p>
          <button className="btn btn--primary" onClick={reset}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  if (status === STATES.UPLOADING) {
    return (
      <div className="fu-body">
        <div className="fu-uploading">
          <div className="fu-uploading-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <p className="fu-uploading-name">{file?.name}</p>
          <p className="fu-uploading-size">{formatBytes(file?.size ?? 0)}</p>
          <div className="fu-progress-bar-track">
            <div className="fu-progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <p className="fu-progress-label">{progress}%</p>
        </div>
      </div>
    )
  }

  return (
    <div className="fu-body">
      <div
        className={`fu-dropzone${status === STATES.DRAGGING ? ' fu-dropzone--active' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip,application/x-zip-compressed"
          className="fu-input"
          onChange={handleFileChange}
        />
        <div className="fu-dropzone-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 16v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1" />
            <polyline points="16 10 12 6 8 10" />
            <line x1="12" y1="6" x2="12" y2="18" />
          </svg>
        </div>
        <p className="fu-dropzone-primary">
          {status === STATES.DRAGGING ? 'Drop to upload' : 'Drag & drop your ZIP file here'}
        </p>
        <p className="fu-dropzone-secondary">or click to browse &mdash; max 5 GB</p>
      </div>
      <p className="fu-hint">Only <strong>.zip</strong> files are accepted.</p>
    </div>
  )
}
