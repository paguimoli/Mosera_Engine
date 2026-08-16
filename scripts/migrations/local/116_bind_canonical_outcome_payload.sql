alter table game_engine.outcome_events
  add column if not exists canonical_payload text;

alter table game_engine.outcome_events disable trigger user;
update game_engine.outcome_events
set canonical_payload = outcome_payload::text
where canonical_payload is null;
alter table game_engine.outcome_events enable trigger user;

alter table game_engine.outcome_events
  alter column canonical_payload set not null,
  add constraint ck_outcome_events_canonical_payload_not_empty
    check (btrim(canonical_payload) <> '');

create or replace function game_engine.bind_canonical_outcome_payload()
returns trigger
language plpgsql
as $$
begin
  if new.canonical_payload is null or btrim(new.canonical_payload) = '' then
    new.canonical_payload := new.outcome_payload::text;
  end if;

  if 'sha256:' || encode(digest(new.canonical_payload, 'sha256'), 'hex')
       <> new.canonical_outcome_hash then
    raise exception 'Canonical outcome payload hash does not match the immutable outcome hash';
  end if;
  return new;
end;
$$;

create trigger trg_bind_canonical_outcome_payload
before insert on game_engine.outcome_events
for each row execute function game_engine.bind_canonical_outcome_payload();

comment on column game_engine.outcome_events.canonical_payload is
  'Exact immutable pre-hash payload bytes used by certificate verification; JSONB remains the query projection.';
