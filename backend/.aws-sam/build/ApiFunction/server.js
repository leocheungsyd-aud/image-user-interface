/**
 * Local development server — mirrors the Lambda handler on http://localhost:3001
 * Run: node server.js  (requires AWS credentials in env or ~/.aws/credentials)
 *
 * Set COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID to enable JWT verification.
 * Omit them to skip auth (useful for local dev).
 */
const express = require('express')
const { buildPresignedUrl, listBuckets, listObjects, verifyToken } = require('./handler')

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
  try {
    res.json(await listObjects(bucket, prefix))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to list objects' })
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
  try {
    res.json(await buildPresignedUrl(filename, contentType, bucket))
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate upload URL' })
  }
})

app.listen(PORT, () => {
  const authEnabled = !!(process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_CLIENT_ID)
  console.log(`Presign server running at http://localhost:${PORT}`)
  console.log(`JWT auth: ${authEnabled ? 'enabled' : 'disabled (set COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID to enable)'}`)
})
