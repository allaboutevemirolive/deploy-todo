import { useEffect, useState, type FormEvent } from 'react'
import { api, type Todo } from './api'

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Run an API call; show any failure instead of silently doing nothing.
  async function run(action: () => Promise<void>) {
    try {
      setError(null)
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    }
  }

  const reload = async () => setTodos(await api.list())

  // Load the list once when the page opens. The flag stops a late response
  // from updating state after the component has gone away.
  useEffect(() => {
    let cancelled = false
    api
      .list()
      .then((data) => {
        if (!cancelled) setTodos(data)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Something went wrong')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const add = (e: FormEvent) => {
    e.preventDefault()
    const value = title.trim()
    if (!value) return
    // Clear the box right away so the next thing you type is never glued
    // onto the previous title while the request is still in flight.
    setTitle('')
    void run(async () => {
      await api.create(value)
      await reload()
    })
  }

  const toggle = (todo: Todo) =>
    void run(async () => {
      await api.setDone(todo.id, !todo.done)
      await reload()
    })

  const remove = (todo: Todo) =>
    void run(async () => {
      await api.remove(todo.id)
      await reload()
    })

  return (
    <main>
      <h1>Todo</h1>
      <form onSubmit={add}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
          maxLength={200}
          aria-label="New todo"
        />
        <button type="submit">Add</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <label className={todo.done ? 'done' : ''}>
              <input type="checkbox" checked={todo.done} onChange={() => toggle(todo)} />
              {todo.title}
            </label>
            <button className="remove" onClick={() => remove(todo)} aria-label={`Delete ${todo.title}`}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {todos.length === 0 && !error && <p className="empty">Nothing to do. Add something above.</p>}
    </main>
  )
}
