import { getIdToken } from './cognito'

export async function authedFetch(url, options = {}) {
  const token = await getIdToken()
  const headers = { ...options.headers }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(url, { ...options, headers })
}
