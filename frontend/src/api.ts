// Relative URLs on purpose: "/api/todos", never "https://some-host/api/todos".
// The browser sends the request to whichever host served the page, so the same
// built files work on localhost, on staging and in production.

export interface Todo {
  id: number
  title: string
  done: boolean
  created_at: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there is one. A DELETE with a JSON
  // content-type but no body is rejected by the server with a 400.
  const headers: Record<string, string> = init?.body ? { 'content-type': 'application/json' } : {}
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const api = {
  list: () => request<Todo[]>('/api/todos'),
  create: (title: string) =>
    request<Todo>('/api/todos', { method: 'POST', body: JSON.stringify({ title }) }),
  setDone: (id: number, done: boolean) =>
    request<Todo>(`/api/todos/${id}`, { method: 'PATCH', body: JSON.stringify({ done }) }),
  remove: (id: number) => request<void>(`/api/todos/${id}`, { method: 'DELETE' }),
}
