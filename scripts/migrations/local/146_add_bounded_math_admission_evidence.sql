begin;

alter table game_engine.math_evaluation_requests
  add column admitted_at timestamptz;

update game_engine.math_evaluation_requests
set admitted_at = created_at
where admitted_at is null;

alter table game_engine.math_evaluation_requests
  alter column admitted_at set default clock_timestamp(),
  alter column admitted_at set not null,
  add constraint chk_math_evaluation_admitted_after_created
    check (admitted_at >= created_at);

create index idx_math_evaluation_requests_admission_queue
  on game_engine.math_evaluation_requests(status, admitted_at, evaluation_request_id);

create or replace function game_engine.validate_math_evaluation_request()
returns trigger
language plpgsql
as $$
begin
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
  'Database-assigned durable admission timestamp. Admission is separate from bounded Math execution.';

commit;
