-- ─── PostgreSQL Initialization Script ───────────────────────────────────
-- This script runs automatically when the PostgreSQL container starts.
-- It enables required extensions and sets up initial database configuration.

-- Enable UUID extension for CUID compatibility
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable JSON support (should be default, but explicit is better)
CREATE EXTENSION IF NOT EXISTS "plpgsql";

-- Create an audit function for tracking changes
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create indexes for common queries (these will also be created by Prisma, but explicit is fine)
-- These are created automatically by Prisma migrations, so this is optional/reference.

-- Log initialization
SELECT NOW() as init_time, 'Database initialization completed' as message;
