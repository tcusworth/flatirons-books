-- Flatirons Books schema. Idempotent: safe to run on every deploy.
-- Money is stored as integer cents (bigint). Dates are plain DATE (no time zone).

create table if not exists businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists accounts (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  code        text,
  name        text not null,
  type        text not null check (type in ('asset','liability','equity','income','expense')),
  -- bank | credit_card | opening_balance | retained_earnings | owner_draw | uncategorized | null
  subtype     text,
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (business_id, code)
);

create table if not exists journal_entries (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  entry_date  date not null,
  memo        text not null default '',
  source      text not null default 'manual' check (source in ('manual','bank','transfer','opening')),
  created_at  timestamptz not null default now()
);
create index if not exists journal_entries_biz_date on journal_entries (business_id, entry_date);

create table if not exists journal_lines (
  id           bigserial primary key,
  entry_id     uuid not null references journal_entries(id) on delete cascade,
  account_id   uuid not null references accounts(id),
  debit_cents  bigint not null default 0 check (debit_cents >= 0),
  credit_cents bigint not null default 0 check (credit_cents >= 0),
  description  text not null default '',
  check ((debit_cents > 0) <> (credit_cents > 0))
);
create index if not exists journal_lines_entry on journal_lines (entry_id);
create index if not exists journal_lines_account on journal_lines (account_id);

-- Every journal entry must balance (debits = credits) and have at least two lines.
-- Checked at COMMIT so lines can be inserted one at a time inside a transaction.
create or replace function check_entry_balanced() returns trigger as $$
declare
  eid uuid := coalesce(new.entry_id, old.entry_id);
  diff bigint;
  n int;
begin
  if not exists (select 1 from journal_entries where id = eid) then
    return null;
  end if;
  select coalesce(sum(debit_cents) - sum(credit_cents), 0), count(*)
    into diff, n from journal_lines where entry_id = eid;
  if n < 2 then
    raise exception 'Journal entry % needs at least two lines', eid;
  end if;
  if diff <> 0 then
    raise exception 'Journal entry % is out of balance by % cents', eid, diff;
  end if;
  return null;
end $$ language plpgsql;

drop trigger if exists journal_lines_balanced on journal_lines;
create constraint trigger journal_lines_balanced
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function check_entry_balanced();

-- An entry with no lines at all is caught here (e.g. entry inserted, lines forgotten).
create or replace function check_entry_has_lines() returns trigger as $$
begin
  if exists (select 1 from journal_entries where id = new.id)
     and not exists (select 1 from journal_lines where entry_id = new.id) then
    raise exception 'Journal entry % has no lines', new.id;
  end if;
  return null;
end $$ language plpgsql;

drop trigger if exists journal_entries_have_lines on journal_entries;
create constraint trigger journal_entries_have_lines
  after insert on journal_entries
  deferrable initially deferred
  for each row execute function check_entry_has_lines();

create table if not exists plaid_items (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  item_id          text not null unique,
  access_token_enc text not null,
  institution_name text not null default '',
  sync_cursor      text,
  status           text not null default 'active', -- active | login_required | error
  last_error       text,
  last_synced_at   timestamptz,
  created_at       timestamptz not null default now()
);

create table if not exists bank_accounts (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id) on delete cascade,
  plaid_item_id         uuid references plaid_items(id) on delete set null,
  plaid_account_id      text unique,
  ledger_account_id     uuid not null references accounts(id),
  name                  text not null,
  mask                  text,
  kind                  text not null check (kind in ('depository','credit')),
  current_balance_cents bigint,
  balance_updated_at    timestamptz,
  created_at            timestamptz not null default now()
);

create table if not exists bank_transactions (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id) on delete cascade,
  bank_account_id       uuid not null references bank_accounts(id) on delete cascade,
  external_id           text not null,
  txn_date              date not null,
  description           text not null,
  merchant              text,
  -- Plaid's convention: positive = money leaving the account, negative = money coming in.
  amount_cents          bigint not null check (amount_cents <> 0),
  bank_category         text,
  source                text not null check (source in ('plaid','csv','pdf')),
  status                text not null default 'review' check (status in ('review','posted','excluded')),
  suggested_account_id  uuid references accounts(id) on delete set null,
  suggestion_confidence real,
  suggestion_reason     text,
  suggestion_source     text check (suggestion_source in ('rule','history','ai','transfer')),
  transfer_match_id     uuid references bank_transactions(id) on delete set null,
  journal_entry_id      uuid references journal_entries(id) on delete set null,
  created_at            timestamptz not null default now(),
  unique (bank_account_id, external_id)
);
create index if not exists bank_txn_biz_status on bank_transactions (business_id, status, txn_date);

create table if not exists categorization_rules (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  pattern     text not null,
  account_id  uuid not null references accounts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (business_id, pattern)
);

-- "Not a transfer" set by the owner, so the matcher stops pairing these lines.
alter table bank_transactions add column if not exists not_transfer boolean not null default false;

-- ---------- AI connector (MCP) ----------

-- Changes an AI app prepares through the connector. Nothing touches the books until approved in the app.
create table if not exists proposed_changes (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  kind        text not null check (kind in ('categorize','exclude','journal_entry','create_rule','create_account')),
  summary     text not null,
  note        text not null default '',
  payload     jsonb not null,
  status      text not null default 'pending' check (status in ('pending','applied','rejected','failed')),
  result      text,
  client_name text,
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
create index if not exists proposed_changes_status on proposed_changes (business_id, status, created_at);

-- OAuth 2.1 for connectors (Claude, etc.). Secrets and tokens are stored only as SHA-256 hashes.
create table if not exists oauth_clients (
  client_id          text primary key,
  client_name        text not null default '',
  redirect_uris      text[] not null,
  client_secret_hash text,
  created_at         timestamptz not null default now()
);

create table if not exists oauth_codes (
  code_hash      text primary key,
  client_id      text not null,
  redirect_uri   text not null,
  code_challenge text not null,
  expires_at     timestamptz not null,
  used           boolean not null default false
);

create table if not exists oauth_tokens (
  token_hash   text primary key,
  kind         text not null check (kind in ('access','refresh')),
  client_id    text not null,
  client_name  text not null default '',
  expires_at   timestamptz not null,
  revoked      boolean not null default false,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists oauth_tokens_client on oauth_tokens (client_id);
