alter table ledger_service.ledger_posting_requests
  drop constraint if exists ledger_posting_requests_ledger_wallet_id_fkey,
  drop constraint if exists ledger_posting_requests_ledger_account_id_fkey,
  drop constraint if exists ledger_posting_requests_original_ledger_entry_id_fkey;

comment on column ledger_service.ledger_posting_requests.ledger_wallet_id is
  'Immutable requested wallet identifier. It is intentionally not a foreign key so rejected attempts remain auditable.';

comment on column ledger_service.ledger_posting_requests.ledger_account_id is
  'Immutable requested account identifier. It is intentionally not a foreign key so rejected attempts remain auditable.';

comment on column ledger_service.ledger_posting_requests.original_ledger_entry_id is
  'Immutable requested reversal target. It is intentionally not a foreign key so rejected attempts remain auditable.';
