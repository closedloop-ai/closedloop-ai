# Server vs Client: Mental Model

The directives `"use client"` and `"use server"` tell you **where the code runs**:

## Three Server-Side Concepts

| Concept | What it is | Infrastructure |
|---------|------------|----------------|
| **Server Components** | React components that render on the server, send back HTML/JS | Vercel Edge/Node runtime |
| **Server Actions** | RPC endpoints for mutations (like AWS Lambda) | Vercel Serverless Functions |
| **API Routes** | Traditional HTTP endpoints, part of our BFF | `apps/api` on Vercel |

## Default: Server Components
In Next.js App Router, all components are **Server Components by default**. They:
- Render on the server and stream HTML/JS to the client
- Can directly fetch data, access environment variables, and use server-only code
- Cannot use React hooks (`useState`, `useEffect`, etc.) or browser APIs
- Are NOT sent to the client bundle (smaller JS payload)

## `"use client"` - Client Components
Add `"use client"` at the top of a file to make it a Client Component:
```tsx
"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0); // Hooks work here
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}
```
Client Components:
- Run in the browser (and once on server for initial HTML)
- Can use hooks, event handlers, browser APIs
- Are included in the client JS bundle
- Cannot directly `import` Server Components (but can receive them as `children` or props — a core App Router composition pattern)

## `"use server"` - Server Actions
Server Actions are **RPC calls** - think of them like serverless functions (AWS Lambda). They run on Vercel infrastructure, not in the browser.

```tsx
"use server";

export async function createItem(formData: FormData) {
  // This is an RPC endpoint - runs on Vercel serverless infra
  // Safe to use secrets, call APIs, etc.
}
```
Server Actions:
- Are RPC endpoints that execute on Vercel's serverless infrastructure
- Can be called from `<form action={serverAction}>` or directly `await serverAction()`
- Useful for mutations, form submissions, and secure operations
- Different from Server Components (which produce UI)

## Quick Reference

| Directive | Where it runs | What it produces |
|-----------|---------------|------------------|
| (none - default) | Server | HTML/JS (UI) - Server Component |
| `"use client"` | Browser | Interactive UI - Client Component |
| `"use server"` | Vercel serverless | RPC response (data) - Server Action |

## Common Patterns

**Fetching data in Server Components:**
```tsx
// app/items/page.tsx (Server Component - no directive needed)
export default async function ItemsPage() {
  const items = await fetchItems(); // Runs on server
  return <ItemList items={items} />;
}
```

**Interactive wrapper around server data:**
```tsx
// components/item-list.tsx
"use client";

export function ItemList({ items }: { items: Item[] }) {
  const [filter, setFilter] = useState("");
  // Interactive filtering on pre-fetched server data
}
```

**Form with Server Action:**
```tsx
// actions/items.ts
"use server";

export async function createItem(formData: FormData) {
  // Secure server-side mutation
}

// components/item-form.tsx
"use client";

import { createItem } from "@/actions/items";

export function ItemForm() {
  return <form action={createItem}>...</form>;
}
```
