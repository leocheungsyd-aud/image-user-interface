/**
 * Local development server — mirrors the Lambda handler on http://localhost:3001
 * Run: node server.js  (requires AWS credentials in env or ~/.aws/credentials)
 */
const express = require('express')
const { buildPresignedUrl, listBuckets, listObjects } = require('./handler')

const PORT = process.env.PORT || 3001

const app = express()
app.use(express.json())

app.use((_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  next()
})

app.options('*', (_, res) => res.sendStatus(204))

app.get('/api/buckets', async (_, res) => {
  try {
    const buckets = await listBuckets()
    res.json({ buckets })
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
    const result = await buildPresignedUrl(filename, contentType, bucket)
    res.json(result)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Failed to generate upload URL' })
  }
})

app.listen(PORT, () => {
  console.log(`Presign server running at http://localhost:${PORT}`)
})
