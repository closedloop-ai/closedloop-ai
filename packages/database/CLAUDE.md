# Prisma Commands After Schema Updates

After updating `packages/database/prisma/schema.prisma`, here are the commands you need:

## Quick Option (Recommended)

```bash
pnpm migrate
```

This single command runs format, generate, and push in sequence.

## Individual Commands

If you need more control, run these from the `packages/database` directory:

```bash
cd packages/database

# 1. Format the schema file (optional but nice)
pnpm prisma format

# 2. Generate the Prisma client (creates types in generated/)
pnpm prisma generate

# 3. Push schema changes to the database (for development)
pnpm prisma db push
```

## When to Use What

| Command | Use Case |
|---------|----------|
| `prisma db push` | Development - applies schema directly without migrations |
| `prisma migrate dev` | When you need migration history (production workflows) |
| `prisma generate` | After any schema change to update TypeScript types |
| `prisma studio` | Opens a GUI to browse/edit data (`pnpm prisma studio`) |

## Important Notes

- **Always run `generate`** after schema changes - otherwise your TypeScript types won't match the database
- **`db push`** is destructive for development - it can drop data if you remove fields
- The generated client lives in `packages/database/generated/` (configured in `prisma.config.ts`)
