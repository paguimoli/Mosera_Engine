alter table game_engine.outcome_provider_execution_evidence
  add column canonical_result_canonical_payload text;

alter table game_engine.outcome_provider_execution_evidence disable trigger user;
update game_engine.outcome_provider_execution_evidence
set canonical_result_canonical_payload = canonical_result_payload::text
where canonical_result_payload is not null;
alter table game_engine.outcome_provider_execution_evidence enable trigger user;

create or replace function game_engine.bind_canonical_provider_result_payload()
returns trigger
language plpgsql
as $$
begin
  if new.canonical_result_payload is null then
    if new.canonical_result_hash is not null
       or new.canonical_result_canonical_payload is not null then
      raise exception 'Canonical provider result payload, canonical bytes, and hash must be supplied together';
    end if;
    return new;
  end if;

  if new.canonical_result_canonical_payload is null
     or btrim(new.canonical_result_canonical_payload) = '' then
    new.canonical_result_canonical_payload := new.canonical_result_payload::text;
  end if;
  if 'sha256:' || encode(digest(new.canonical_result_canonical_payload, 'sha256'), 'hex')
       <> new.canonical_result_hash then
    raise exception 'Canonical provider result payload hash does not match its immutable canonical bytes';
  end if;
  return new;
end;
$$;

create trigger trg_bind_canonical_provider_result_payload
before insert on game_engine.outcome_provider_execution_evidence
for each row execute function game_engine.bind_canonical_provider_result_payload();

comment on column game_engine.outcome_provider_execution_evidence.canonical_result_canonical_payload is
  'Exact immutable canonical provider-result bytes used to compute canonical_result_hash.';
