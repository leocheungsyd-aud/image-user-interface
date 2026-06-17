/**
 * Local development server — mirrors the Lambda handler on http://localhost:3001
 * Run: node server.js  (requires AWS credentials in env or ~/.aws/credentials)
 *
 * Set COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID to enable JWT verification.
 * Omit them to skip auth (useful for local dev).
 */
const express = require('express')
const {
  buildPresignedUrl,
  buildPresignedDownloadUrl,
  listBuckets,
  listObjects,
  verifyToken,
  ALLOWED_BUCKETS,
  createMultipartUpload,
  presignParts,
  completeMultipartUpload,
  abortMultipartUpload,
} = require('./handler')

const PORT = process.env.PORT || 3001

const app = express()
app.use(express.json())

app.use((_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  next()
})

app.options('*', (_, res) => res.sendStatus(204))

// Auth middleware
async function requireAuth(req, res, next) {
  try {
    await verifyToken(req.headers.authorization)
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
  }
}

app.use('/api', requireAuth)

app.get('/api/buckets', async (_, res) => {
  try {
    res.json({ buckets: await listBuckets() })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to list buckets' })
  }
})

app.get('/api/objects', async (req, res) => {
  const { bucket, prefix = '' } = req.query
  if (!bucket) return res.status(400).json({ error: 'bucket is required' })
  if (!ALLOWED_BUCKETS.includes(bucket)) return res.status(403).json({ error: 'Bucket not allowed' })
  try {
    res.json(await listObjects(bucket, prefix))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to list objects' })
  }
})

app.get('/api/presign-download', async (req, res) => {
  const { bucket, key } = req.query
  if (!bucket || !key) return res.status(400).json({ error: 'bucket and key are required' })
  try {
    res.json(await buildPresignedDownloadUrl(bucket, key))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate download URL' })
  }
})

app.post('/api/presign', async (req, res) => {
  const { filename, contentType, bucket } = req.body ?? {}
  if (!filename || !contentType) {
    return res.status(400).json({ error: 'filename and contentType are required' })
  }
  if (!filename.toLowerCase().endsWith('.zip')) {
    return res.status(400).json({ error: 'Only .zip files are accepted' })
  }
  if (bucket && !ALLOWED_BUCKETS.includes(bucket)) return res.status(403).json({ error: 'Bucket not allowed' })
  try {
    res.json(await buildPresignedUrl(filename, contentType, bucket))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate upload URL' })
  }
})

app.post('/api/multipart/create', async (req, res) => {
  const { filename, contentType, bucket } = req.body ?? {}
  if (!filename || !contentType) return res.status(400).json({ error: 'filename and contentType are required' })
  if (!filename.toLowerCase().endsWith('.zip')) return res.status(400).json({ error: 'Only .zip files are accepted' })
  if (bucket && !ALLOWED_BUCKETS.includes(bucket)) return res.status(403).json({ error: 'Bucket not allowed' })
  try {
    res.json(await createMultipartUpload(filename, contentType, bucket))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to create multipart upload' })
  }
})

app.post('/api/multipart/presign-parts', async (req, res) => {
  const { key, bucket, uploadId, partNumbers } = req.body ?? {}
  if (!key || !bucket || !uploadId || !Array.isArray(partNumbers) || partNumbers.length === 0) {
    return res.status(400).json({ error: 'key, bucket, uploadId, and partNumbers are required' })
  }
  if (!ALLOWED_BUCKETS.includes(bucket)) return res.status(403).json({ error: 'Bucket not allowed' })
  if (!key.startsWith('upload/')) return res.status(403).json({ error: 'Invalid key' })
  try {
    res.json({ parts: await presignParts(bucket, key, uploadId, partNumbers) })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to presign parts' })
  }
})

app.post('/api/multipart/complete', async (req, res) => {
  const { key, bucket, uploadId, parts } = req.body ?? {}
  if (!key || !bucket || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: 'key, bucket, uploadId, and parts are required' })
  }
  if (!ALLOWED_BUCKETS.includes(bucket)) return res.status(403).json({ error: 'Bucket not allowed' })
  if (!key.startsWith('upload/')) return res.status(403).json({ error: 'Invalid key' })
  try {
    res.json(await completeMultipartUpload(bucket, key, uploadId, parts))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to complete multipart upload' })
  }
})

app.post('/api/multipart/abort', async (req, res) => {
  const { key, bucket, uploadId } = req.body ?? {}
  if (!key || !bucket || !uploadId) return res.status(400).json({ error: 'key, bucket, and uploadId are required' })
  if (!ALLOWED_BUCKETS.includes(bucket)) return res.status(403).json({ error: 'Bucket not allowed' })
  try {
    await abortMultipartUpload(bucket, key, uploadId)
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to abort multipart upload' })
  }
})

app.listen(PORT, () => {
  const authEnabled = !!(process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_CLIENT_ID)
  console.log(`Presign server running at http://localhost:${PORT}`)
  console.log(`JWT auth: ${authEnabled ? 'enabled' : 'disabled (set COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID to enable)'}`)
})
