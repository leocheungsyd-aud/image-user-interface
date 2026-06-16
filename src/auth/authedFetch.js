import { getIdToken } from './cognito'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

export async function authedFetch(url, options = {}) {
  const token = await getIdToken()
  const headers = { ...options.headers }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(`${API_BASE}${url}`, { ...options, headers })
}
