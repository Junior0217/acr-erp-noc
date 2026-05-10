const BASE = 'http://localhost:3000'

function getCsrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]*)/)
  return m ? decodeURIComponent(m[1]) : null
}

export async function apiFetch(path, options = {}) {
  const { headers, ...rest } = options
  const method    = (rest.method || 'GET').toUpperCase()
  const mutating  = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  const csrfToken = mutating ? getCsrfToken() : null
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...headers,
    },
  })
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('auth:logout'))
  }
  return res
}
