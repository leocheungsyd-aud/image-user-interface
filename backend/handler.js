const { S3Client, PutObjectCommand, ListBucketsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

const REGION = 'ap-southeast-2'
const DEFAULT_BUCKET = 'raw-678865629508-ap-southeast-2-an'
const PREFIX = 'upload/'
const EXPIRES_IN = 900 // 15 minutes

const s3 = new S3Client({ region: REGION })

function corsHeaders(origin = '*') {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }
}

async function buildPresignedUrl(filename, contentType, bucket = DEFAULT_BUCKET) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_')
  const key = `${PREFIX}${Date.now()}-${safeFilename}`
  const command = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  const url = await getSignedUrl(s3, command, { expiresIn: EXPIRES_IN })
  return { url, key }
}

async function listBuckets() {
  const { Buckets } = await s3.send(new ListBucketsCommand({}))
  return (Buckets ?? []).map((b) => ({ name: b.Name, createdAt: b.CreationDate }))
}

async function listObjects(bucket, prefix = '') {
  const { CommonPrefixes, Contents } = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 1000 }),
  )
  return {
    prefixes: (CommonPrefixes ?? []).map((p) => p.Prefix),
    objects: (Contents ?? [])
      .filter((o) => o.Key !== prefix)
      .map((o) => ({ key: o.Key, size: o.Size, lastModified: o.LastModified })),
  }
}

// ── Lambda handler ──────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const origin = event.headers?.origin ?? '*'
  const method = event.httpMethod
  const path = event.path ?? event.rawPath ?? '/'
  const qs = event.queryStringParameters ?? {}

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' }
  }

  // GET /api/buckets
  if (method === 'GET' && path.endsWith('/buckets')) {
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify({ buckets: await listBuckets() }) }
    } catch (err) {
      console.error('Failed to list buckets', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to list buckets' }) }
    }
  }

  // GET /api/objects?bucket=<name>&prefix=<prefix>
  if (method === 'GET' && path.endsWith('/objects')) {
    const { bucket, prefix = '' } = qs
    if (!bucket) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'bucket is required' }) }
    }
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(await listObjects(bucket, prefix)) }
    } catch (err) {
      console.error('Failed to list objects', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to list objects' }) }
    }
  }

  // POST /api/presign
  if (method === 'POST' && path.endsWith('/presign')) {
    let body
    try {
      body = JSON.parse(event.body || '{}')
    } catch {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Invalid JSON body' }) }
    }

    const { filename, contentType, bucket } = body
    if (!filename || !contentType) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'filename and contentType are required' }) }
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
      return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Only .zip files are accepted' }) }
    }
    try {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(await buildPresignedUrl(filename, contentType, bucket)) }
    } catch (err) {
      console.error('Failed to generate presigned URL', err)
      return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Failed to generate upload URL' }) }
    }
  }

  return { statusCode: 404, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Not found' }) }
}

module.exports.buildPresignedUrl = buildPresignedUrl
module.exports.listBuckets = listBuckets
module.exports.listObjects = listObjects
