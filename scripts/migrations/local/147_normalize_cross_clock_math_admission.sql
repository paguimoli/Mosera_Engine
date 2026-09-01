begin;

create or replace function game_engine.validate_math_evaluation_request()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.admitted_at := greatest(new.admitted_at, new.created_at);
  end if;

  if tg_op = 'UPDATE' and new.admitted_at is distinct from old.admitted_at then
    raise exception 'Math Evaluation admission timestamp is immutable';
  end if;

  if new.status = 'Completed' then
    if new.completed_at is null
      or new.math_evaluation_id is null
      or new.certificate_id is null
      or new.certificate_hash is null then
      raise exception 'Completed Math Evaluation requests require completion evidence';
    end if;
  end if;

  if new.status <> 'Completed' and (
    new.math_evaluation_id is not null
    or new.certificate_id is not null
    or new.certificate_hash is not null) then
    raise exception 'Incomplete Math Evaluation requests cannot carry certificate evidence';
  end if;

  if new.status = 'Failed' and coalesce(new.failure_code, '') = '' then
    raise exception 'Failed Math Evaluation requests require a failure code';
  end if;

  if new.evaluation_mode = 'ProductionDisabled' then
    raise exception 'Production Math Authority evaluation is disabled';
  end if;

  return new;
end;
$$;

comment on column game_engine.math_evaluation_requests.admitted_at is
  'Database-assigned durable admission timestamp normalized against the immutable request-created timestamp.';

commit;
