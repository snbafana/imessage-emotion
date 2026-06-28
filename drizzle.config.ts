import { defineConfig } from 'drizzle-kit'

// Drizzle owns the connection (see src/lib/db/connection.ts). Table DDL currently
// lives in src/lib/db/schema.ts (migrate()); this config is the seam for
// generating Drizzle migrations as the schema moves into Drizzle table defs.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
})
