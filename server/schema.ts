/** Database schema, applied idempotently at start-up (embedded so serverless bundles need no file access). */
export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('partner','accountant','viewer')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  grp TEXT NOT NULL,
  fs_line TEXT NOT NULL,
  party_type TEXT CHECK (party_type IN ('partner','employee','vendor','customer','tax')),
  party TEXT,
  system_role TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
  file_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  period_from DATE,
  period_to DATE,
  entries INTEGER NOT NULL DEFAULT 0,
  summary JSONB,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL,
  ref TEXT,
  memo TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','adjustment','proposed')),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  batch_id INTEGER REFERENCES import_batches(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS je_date_idx ON journal_entries(entry_date);
CREATE TABLE IF NOT EXISTS journal_lines (
  id SERIAL PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  payee TEXT
);
CREATE INDEX IF NOT EXISTS jl_entry_idx ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS jl_account_idx ON journal_lines(account_id);
CREATE TABLE IF NOT EXISTS partners (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  aka TEXT,
  ratio NUMERIC(8,6) NOT NULL DEFAULT 0,
  committed_capital NUMERIC(18,2) NOT NULL DEFAULT 0,
  account_id INTEGER REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  number TEXT,
  invoice_date DATE NOT NULL,
  client TEXT NOT NULL,
  billed_to TEXT,
  campaign_period TEXT,
  net_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  jazz_share NUMERIC(18,4) NOT NULL DEFAULT 0,
  gst_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
  gst NUMERIC(18,4) NOT NULL DEFAULT 0,
  gross_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  income_tax_withheld NUMERIC(18,4) NOT NULL DEFAULT 0,
  sales_tax_withheld NUMERIC(18,4) NOT NULL DEFAULT 0,
  received NUMERIC(18,4) NOT NULL DEFAULT 0,
  outstanding NUMERIC(18,4) NOT NULL DEFAULT 0,
  received_dates TEXT,
  notes TEXT,
  status TEXT,
  expected_date DATE,
  collection_probability NUMERIC(5,2) NOT NULL DEFAULT 100,
  batch_id INTEGER REFERENCES import_batches(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS obligations (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  amount NUMERIC(18,2) NOT NULL,
  due_date DATE NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','scheduled','paid','deferred')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS findings (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  area TEXT NOT NULL,
  detail TEXT NOT NULL,
  impact NUMERIC(18,2),
  recommendation TEXT,
  owner TEXT,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','accepted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS questions (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE,
  topic TEXT NOT NULL,
  question TEXT NOT NULL,
  why TEXT,
  answer TEXT,
  answered_by INTEGER REFERENCES users(id),
  answered_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
)
;
CREATE TABLE IF NOT EXISTS sfp_campaigns (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sfp_payments (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS sfp_targets (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL
)
`;
