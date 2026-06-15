const REGION = 'ap-southeast-2'
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID
const ENDPOINT = `https://cognito-idp.${REGION}.amazonaws.com/`
const STORAGE_KEY = 'zip_uploader_tokens'

function cognitoPost(target, body) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json()
    if (!r.ok) throw new Error(data.message || data.__type || 'Authentication error')
    return data
  })
}

export async function signIn(email, password) {
  if (!CLIENT_ID) throw new Error('Cognito is not configured — set VITE_COGNITO_CLIENT_ID in .env.local')
  const result = await cognitoPost('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  })
  if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    throw new Error('You must set a new password before signing in. Please contact your administrator.')
  }
  if (!result.AuthenticationResult) {
    throw new Error(`Sign-in challenge not supported: ${result.ChallengeName ?? 'unknown'}`)
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(result.AuthenticationResult))
  return result.AuthenticationResult
}

export function signOut() {
  localStorage.removeItem(STORAGE_KEY)
}

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch {
    return null
  }
}

function isExpired(token) {
  const payload = parseJwt(token)
  return !payload || payload.exp * 1000 < Date.now()
}

function loadTokens() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function refreshTokens(refreshToken) {
  try {
    const { AuthenticationResult } = await cognitoPost('InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    })
    const tokens = { ...AuthenticationResult, RefreshToken: refreshToken }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens))
    return tokens
  } catch {
    localStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export async function getCurrentSession() {
  const tokens = loadTokens()
  if (!tokens) return null
  if (!isExpired(tokens.IdToken)) return tokens
  if (tokens.RefreshToken) return refreshTokens(tokens.RefreshToken)
  return null
}

export async function getIdToken() {
  const session = await getCurrentSession()
  return session?.IdToken ?? null
}

export function parseUserFromSession(session) {
  return parseJwt(session?.IdToken)
}
