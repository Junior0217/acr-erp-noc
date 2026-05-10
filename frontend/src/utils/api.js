const BASE = 'http://localhost:3000'

export async function apiFetch(path, options = {}) {
  const { headers, ...rest } = options
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...headers },
  })
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:logout'))
  }
  return res
}
