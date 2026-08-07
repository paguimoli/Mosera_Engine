begin;

alter table ticket_authority.availability_decisions
  drop constraint if exists availability_decisions_decision_hash_key;

create index if not exists idx_availability_decisions_decision_hash
  on ticket_authority.availability_decisions(decision_hash);

comment on index ticket_authority.idx_availability_decisions_decision_hash is
  'Lookup for immutable effective-decision evidence; identical effective decisions may apply to multiple tickets.';

commit;
